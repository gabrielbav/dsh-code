/**
 * Browser bridge that runs INSIDE a Code workspace container for the isolated browser of the Preview tab. It starts
 * headless Chromium bound to 127.0.0.1, streams screencast frames to stdout as JSON lines, and applies only the
 * validated actions of {@link ./browser-protocol.ts} read from stdin. Page code runs here, under gVisor, never in the
 * viewer's browser; the viewer only ever sees JPEG frames.
 *
 * Bundled to `worker/browser-bridge.js` and baked into the worker image at `/opt/dsh-code/browser-bridge.js`.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { allowedUrl, parseBrowserInput, type BrowserInput, type BrowserOutput } from './browser-protocol.ts'

const send = (message: BrowserOutput): void => { process.stdout.write(`${JSON.stringify(message)}\n`) }
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const startUrl = allowedUrl(process.argv[2]) ?? 'about:blank'
const profile = mkdtempSync(join('/tmp', 'dsh-browser-'))
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy
let width = 1280
let height = 800

const chrome = spawn('/usr/local/bin/dsh-chromium', [
  // The container (gVisor, no capabilities) is the sandbox; Chromium's own sandbox needs privileges it does not have.
  '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-networking', '--disable-sync', '--metrics-recording-only', '--mute-audio',
  '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`,
  ...proxy === undefined ? [] : [`--proxy-server=${proxy}`],
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
chrome.stderr.resume()

const cleanup = (): void => {
  chrome.kill('SIGKILL')
  rmSync(profile, { recursive: true, force: true })
}
process.on('exit', cleanup)
chrome.on('exit', (code) => { send({ type: 'error', message: `Chromium exited (${String(code)})` }); process.exit(1) })

async function devtoolsPort(): Promise<number> {
  for (let i = 0; i < 100; i++) {
    try {
      const port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0])
      if (port > 0) return port
    } catch { /* Chromium has not written the file yet */ }
    await sleep(100)
  }
  throw new Error('Chromium did not open its DevTools port')
}

async function main(): Promise<void> {
  const port = await devtoolsPort()
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[]
  const page = targets.find(t => t.type === 'page')
  if (page === undefined) throw new Error('Chromium has no page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map<number, (result: unknown) => void>()
  const call = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
  await new Promise<void>((resolve, reject) => { ws.onopen = () => { resolve() }; ws.onerror = () => { reject(new Error('cannot reach Chromium')) } })
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }
    if (message.id !== undefined) {
      pending.get(message.id)?.(message.result)
      pending.delete(message.id)
      return
    }
    if (message.method === 'Page.screencastFrame') {
      const params = message.params as { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }
      send({ type: 'frame', data: params.data, width: Math.round(params.metadata.deviceWidth), height: Math.round(params.metadata.deviceHeight) })
      void call('Page.screencastFrameAck', { sessionId: params.sessionId })
    } else if (message.method === 'Page.frameNavigated') {
      const frame = (message.params as { frame: { parentId?: string; url: string } }).frame
      if (frame.parentId === undefined) send({ type: 'url', url: frame.url })
    }
  }
  ws.onclose = () => { process.exit(0) }

  const screencast = async (): Promise<void> => {
    await call('Page.stopScreencast')
    await call('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: width, maxHeight: height, everyNthFrame: 1 })
  }
  await call('Page.enable')
  await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await screencast()
  if (startUrl !== 'about:blank') await call('Page.navigate', { url: startUrl })
  send({ type: 'ready' })

  const apply = async (input: BrowserInput): Promise<void> => {
    switch (input.kind) {
      case 'navigate': await call('Page.navigate', { url: input.url }); return
      case 'history': {
        if (input.action === 'reload') { await call('Page.reload'); return }
        const history = await call('Page.getNavigationHistory') as { currentIndex: number; entries: { id: number }[] }
        const entry = history.entries[history.currentIndex + (input.action === 'back' ? -1 : 1)]
        if (entry !== undefined) await call('Page.navigateToHistoryEntry', { entryId: entry.id })
        return
      }
      case 'resize':
        width = input.width
        height = input.height
        await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
        await screencast()
        return
      case 'mouse':
        await call('Input.dispatchMouseEvent', { type: input.event, x: input.x, y: input.y, button: input.button, clickCount: input.clickCount, modifiers: input.modifiers })
        return
      case 'wheel':
        await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY, modifiers: input.modifiers })
        return
      case 'key':
        await call('Input.dispatchKeyEvent', {
          type: input.event, key: input.key, code: input.code, modifiers: input.modifiers, windowsVirtualKeyCode: input.keyCode,
          ...input.text === '' ? {} : { text: input.text },
        })
        return
    }
  }
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    let raw: unknown
    try { raw = JSON.parse(line) } catch { return }
    const input = parseBrowserInput(raw)
    if (input !== undefined) void apply(input).catch((error: unknown) => { send({ type: 'error', message: String(error) }) })
  })
  // The host closing the exec ends the browser.
  lines.on('close', () => { process.exit(0) })
}

main().catch((error: unknown) => {
  send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  process.exit(1)
})
