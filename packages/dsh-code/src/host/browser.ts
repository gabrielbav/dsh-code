/**
 * Isolated browser sessions for the Preview tab. Each Code session gets at most one browser bridge (Chromium inside
 * its container, see `src/worker/browser-bridge.ts`), reached through `docker exec` like every Code operation. The
 * host keeps the latest screencast frame for the viewer to fetch, forwards validated input, and closes a bridge that
 * nobody has looked at for a minute.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { parseBrowserInput, type BrowserOutput } from '../worker/browser-protocol.ts'

/** Latest picture of an isolated browser. */
export interface BrowserFrame {
  readonly seq: number
  /** Base64 JPEG. */
  readonly image: string
  readonly width: number
  readonly height: number
  readonly url: string
}

const IDLE_MS = 60_000

class BrowserSession {
  private readonly child: ChildProcessWithoutNullStreams
  private frame: BrowserFrame | undefined
  private url = ''
  private seq = 0
  private waiters = new Set<() => void>()
  private idle: NodeJS.Timeout | undefined
  error: string | undefined
  closed = false

  constructor(argv: readonly string[], private readonly onClose: () => void) {
    this.child = spawn('docker', [...argv], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stderr.resume()
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message: BrowserOutput
      try { message = JSON.parse(line) as BrowserOutput } catch { return }
      if (message.type === 'frame') {
        this.frame = { seq: ++this.seq, image: message.data, width: message.width, height: message.height, url: this.url }
        this.wake()
      } else if (message.type === 'url') {
        this.url = message.url
        if (this.frame !== undefined) this.frame = { ...this.frame, url: message.url }
      } else if (message.type === 'error') {
        this.error = message.message
        this.wake()
      }
    })
    this.child.on('exit', () => { this.close() })
    this.child.on('error', (error) => { this.error = error.message; this.close() })
    this.touch()
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter()
    this.waiters.clear()
  }

  private touch(): void {
    if (this.idle !== undefined) clearTimeout(this.idle)
    this.idle = setTimeout(() => { this.close() }, IDLE_MS)
  }

  /** The first frame newer than `after`, waiting up to `timeoutMs`; undefined when none arrived. */
  async next(after: number, timeoutMs: number): Promise<BrowserFrame | undefined> {
    this.touch()
    if (this.frame !== undefined && this.frame.seq > after) return this.frame
    if (this.closed) return undefined
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.waiters.delete(done); resolve() }, timeoutMs)
      const done = (): void => { clearTimeout(timer); resolve() }
      this.waiters.add(done)
    })
    return this.frame !== undefined && this.frame.seq > after ? this.frame : undefined
  }

  /** Forward one action; anything outside the protocol is dropped here as well as in the bridge. */
  send(raw: unknown): boolean {
    const input = parseBrowserInput(raw)
    if (input === undefined || this.closed) return false
    this.touch()
    this.child.stdin.write(`${JSON.stringify(input)}\n`)
    return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.idle !== undefined) clearTimeout(this.idle)
    this.child.stdin.end()
    this.child.kill()
    this.wake()
    this.onClose()
  }
}

/** All isolated browsers of this Host. */
export class IsolatedBrowsers {
  private readonly sessions = new Map<string, BrowserSession>()

  /**
   * The browser of a session, started when missing.
   * @param sessionId - logical session id.
   * @param argv - `docker` argv that runs the bridge in the session's container (with the start URL).
   * @returns the session, or the error that stopped the previous one.
   */
  ensure(sessionId: string, argv: () => Promise<readonly string[]>): Promise<BrowserSession> {
    const known = this.sessions.get(sessionId)
    if (known !== undefined && !known.closed) return Promise.resolve(known)
    return argv().then((resolved) => {
      const session = new BrowserSession(resolved, () => { if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId) })
      this.sessions.set(sessionId, session)
      return session
    })
  }

  /** The running browser of a session, if any. */
  get(sessionId: string): BrowserSession | undefined {
    const session = this.sessions.get(sessionId)
    return session?.closed === false ? session : undefined
  }

  /** Close one session's browser (session deleted, Preview turned off, isolated mode turned off). */
  close(sessionId: string): void {
    this.sessions.get(sessionId)?.close()
  }

  /** Close every browser (plugin disposal). */
  closeAll(): void {
    for (const session of this.sessions.values()) session.close()
  }
}
