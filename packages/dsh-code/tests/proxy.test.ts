import { afterEach, describe, expect, it } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { createEgressProxy, type EgressEvent, type EgressProxy } from '../src/egress/proxy.ts'
import type { EgressPolicy } from '../src/egress/policy.ts'

const owned: Array<{ close(): unknown }> = []
afterEach(async () => {
  for (const item of owned.splice(0)) await item.close()
})

function listen(server: Server): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => { resolve((server.address() as AddressInfo).port) }))
}

async function setup(policy: EgressPolicy, resolve: (h: string) => Promise<string[]>) {
  const upstream = createServer((req, res) => { res.end(`ok ${req.url}`) })
  const upstreamPort = await listen(upstream)
  owned.push({ close: () => new Promise(r => upstream.close(r)) })
  const events: EgressEvent[] = []
  let current = policy
  const proxy: EgressProxy = createEgressProxy({ policy: () => current, resolve, log: e => events.push(e) })
  const proxyPort = await listen(proxy.server)
  owned.push(proxy)
  return { upstreamPort, proxyPort, events, proxy, setPolicy: (p: EgressPolicy) => { current = p } }
}

function connectThrough(proxyPort: number, authority: string): Promise<{ status: string; socket: import('node:net').Socket }> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, '127.0.0.1', () => { socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`) })
    socket.once('data', (chunk) => { resolve({ status: chunk.toString().split('\r\n')[0]!, socket }) })
    socket.once('error', reject)
  })
}

describe('egress proxy', () => {
  it('refuses connections beyond its cap before doing any work', async () => {
    const proxy = createEgressProxy({ policy: () => ({ mode: 'allowlist', allow: [], privateAllow: [], ports: [] }), resolve: async () => [], maxConnections: 2 })
    const port = await listen(proxy.server)
    owned.push(proxy)
    const open = (): Promise<import('node:net').Socket> => new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => { resolve(socket) })
      socket.once('error', reject)
    })
    const held = [await open(), await open()]
    // A third socket is accepted by the kernel, then closed by the server without a single byte.
    const third = await open()
    const closed = await new Promise<{ bytes: number }>((resolve) => {
      let bytes = 0
      third.on('data', (chunk) => { bytes += chunk.length })
      third.once('close', () => { resolve({ bytes }) })
      third.write('CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n')
    })
    expect(closed.bytes).toBe(0)
    for (const socket of held) socket.destroy()
  })

  it('tunnels an approved CONNECT to the checked address', async () => {
    const ctx = await setup({ mode: 'allowlist', allow: ['example.test'], privateAllow: [], ports: [] }, async () => ['127.0.0.1'])
    // Loopback is private, so the test approves it explicitly as a private destination.
    ctx.setPolicy({ mode: 'allowlist', allow: ['example.test'], privateAllow: [`example.test:${ctx.upstreamPort}`], ports: [] })
    const { status, socket } = await connectThrough(ctx.proxyPort, `example.test:${ctx.upstreamPort}`)
    expect(status).toBe('HTTP/1.1 200 Connection Established')
    const body = await new Promise<string>((resolve) => {
      socket.write('GET /x HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n')
      let data = ''
      socket.on('data', (c) => { data += c.toString() })
      socket.on('end', () => { resolve(data) })
    })
    expect(body).toContain('ok /x')
  })

  it('refuses a rebinding answer to a private address', async () => {
    const ctx = await setup({ mode: 'allowlist', allow: ['example.test'], privateAllow: [], ports: [443] }, async () => ['10.0.0.7'])
    const { status, socket } = await connectThrough(ctx.proxyPort, 'example.test:443')
    socket.destroy()
    expect(status).toBe('HTTP/1.1 403 Forbidden')
    expect(ctx.events.at(-1)).toMatchObject({ allowed: false, address: '10.0.0.7' })
  })

  it('refuses unapproved hosts and direct IPs', async () => {
    const ctx = await setup({ mode: 'allowlist', allow: ['example.test'], privateAllow: [], ports: [443] }, async () => ['93.184.216.34'])
    for (const authority of ['other.test:443', '93.184.216.34:443', '[2606:2800::1]:443']) {
      const { status, socket } = await connectThrough(ctx.proxyPort, authority)
      socket.destroy()
      expect(status, authority).toBe('HTTP/1.1 403 Forbidden')
    }
  })

  it('checks plain HTTP requests, including redirects followed by the client', async () => {
    const ctx = await setup({ mode: 'allowlist', allow: ['blocked-only.test'], privateAllow: [], ports: [80] }, async () => ['127.0.0.1'])
    const status = await new Promise<number>((resolve) => {
      request({ host: '127.0.0.1', port: ctx.proxyPort, path: 'http://redirect-target.test/', method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode ?? 0) }).end()
    })
    expect(status).toBe(403)
  })

  it('closes open tunnels a tightened policy no longer admits', async () => {
    const ctx = await setup({ mode: 'allowlist', allow: ['example.test'], privateAllow: [], ports: [] }, async () => ['127.0.0.1'])
    ctx.setPolicy({ mode: 'allowlist', allow: ['example.test'], privateAllow: [`example.test:${ctx.upstreamPort}`], ports: [] })
    const { status, socket } = await connectThrough(ctx.proxyPort, `example.test:${ctx.upstreamPort}`)
    expect(status).toContain('200')
    const closed = new Promise<void>(resolve => socket.on('close', () => { resolve() }))
    ctx.setPolicy({ mode: 'none', allow: [], privateAllow: [], ports: [] })
    ctx.proxy.reevaluate()
    await closed
  })

  it('applies a session grant only to the client it belongs to and explains the block', async () => {
    const ctx = await setup({ mode: 'allowlist', allow: [], privateAllow: [], ports: [443], clients: { '10.9.9.9': ['granted.test'] } }, async () => ['10.0.0.7'])
    const other = await new Promise<string>((resolve, reject) => {
      const socket = connect(ctx.proxyPort, '127.0.0.1', () => { socket.write('CONNECT granted.test:443 HTTP/1.1\r\nHost: granted.test:443\r\n\r\n') })
      let data = ''
      socket.on('data', (c) => { data += c.toString() })
      socket.on('close', () => { resolve(data) })
      socket.on('error', reject)
    })
    expect(other.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden')
    expect(other).toContain('[sandbox: network access to granted.test denied by the Code egress policy]')
    expect(other).toContain('request_network_access')
    // The same grant keyed by this client's address admits it, up to the address check (no real connection here).
    ctx.setPolicy({ mode: 'allowlist', allow: [], privateAllow: [], ports: [443], clients: { '127.0.0.1': ['granted.test'] } })
    const mine = await connectThrough(ctx.proxyPort, 'granted.test:443')
    mine.socket.destroy()
    expect(ctx.events.at(-1)).toMatchObject({ allowed: false, address: '10.0.0.7' })
  })
})
