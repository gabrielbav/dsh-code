import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { PREVIEW_CSP, PreviewProxy, rewriteLocation } from '../src/host/preview.ts'

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d: string) => { body += d })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body }) })
    })
    req.on('error', reject)
    req.end()
  })
}

describe('preview proxy', () => {
  let upstream: Server
  let front: Server
  let seen: Record<string, string | string[] | undefined> = {}
  let now = 1_000
  const proxy = new PreviewProxy(async (sessionId, port) => {
    if (sessionId !== 's1') throw new Error('no such workspace')
    return { port, connect: () => connect(port, '127.0.0.1') }
  }, () => now)
  let upstreamPort = 0
  let frontPort = 0

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      seen = req.headers
      if (req.url === '/go') { res.writeHead(302, { location: '/landing' }); res.end(); return }
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'dsh-auth-x=stolen', 'content-security-policy': "default-src *", 'access-control-allow-origin': '*' })
      res.end(`path=${req.url}`)
    })
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r))
    upstreamPort = (upstream.address() as AddressInfo).port
    front = createServer((req, res) => { void proxy.handle(req, res) })
    await new Promise<void>(r => front.listen(0, '127.0.0.1', r))
    frontPort = (front.address() as AddressInfo).port
  })

  afterAll(() => { upstream.close(); front.close() })

  it('proxies with a valid token, confines the response and never forwards credentials', async () => {
    const base = proxy.mint('s1', upstreamPort)
    const res = await get(frontPort, `${base}app/index.html?q=1`, { cookie: 'dsh-auth-x=secret', authorization: 'Bearer t' })
    expect(res.status).toBe(200)
    expect(res.body).toBe('path=/app/index.html?q=1')
    expect(res.headers['content-security-policy']).toBe(PREVIEW_CSP)
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    expect(seen.cookie).toBeUndefined()
    expect(seen.authorization).toBeUndefined()
    expect(seen.host).toBe(`localhost:${upstreamPort}`)
  })

  it('keeps redirects inside the preview', async () => {
    const base = proxy.mint('s1', upstreamPort)
    const res = await get(frontPort, `${base}go`)
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(`${base}landing`)
    expect(rewriteLocation(`http://localhost:${upstreamPort}/x?y`, '/p/t', upstreamPort)).toBe('/p/t/x?y')
    expect(rewriteLocation('https://example.org/', '/p/t', upstreamPort)).toBe('https://example.org/')
  })

  it('refuses unknown, expired and revoked tokens', async () => {
    expect((await get(frontPort, '/dsh-code/preview/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/')).status).toBe(404)
    const base = proxy.mint('s1', upstreamPort)
    now += 9 * 60 * 60 * 1000
    expect((await get(frontPort, base)).status).toBe(404)
    const again = proxy.mint('s1', upstreamPort)
    proxy.revoke('s1')
    expect((await get(frontPort, again)).status).toBe(404)
  })

  it('reports an unavailable workspace', async () => {
    const res = await get(frontPort, proxy.mint('gone', 1))
    expect(res.status).toBe(502)
    expect(res.headers['content-security-policy']).toBe(PREVIEW_CSP)
  })
})
