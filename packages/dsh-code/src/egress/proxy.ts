/**
 * Trusted egress proxy. Runs in its own container attached to the internal
 * workspace network and to an outbound network; workspace containers have
 * no other route. Supports HTTP CONNECT (TLS tunnels) and absolute-URI plain
 * HTTP requests. Each connection resolves the name once, checks every
 * resolved address, and connects to the checked address, so a rebinding DNS
 * answer cannot redirect an admitted connection. Plain-HTTP redirects reach
 * the client, whose follow-up request is checked again. Policy reloads close
 * tunnels that the new policy no longer admits.
 *
 * Decisions are written as JSON lines to stdout for the host to collect.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import { lookup } from 'node:dns/promises'
import { readFileSync, watchFile } from 'node:fs'
import { decideAddress, decideRequest, policyForClient, type Decision, type EgressPolicy } from './policy.ts'

/** Resolves a hostname to IPv4/IPv6 addresses. */
export type Resolver = (host: string) => Promise<string[]>

/** One decision log line. */
export interface EgressEvent {
  readonly time: string
  readonly kind: 'connect' | 'http'
  readonly host: string
  readonly port: number
  readonly allowed: boolean
  readonly reason?: string
  readonly address?: string
}

/** Proxy options. */
export interface ProxyOptions {
  readonly policy: () => EgressPolicy
  readonly resolve?: Resolver
  readonly log?: (event: EgressEvent) => void
  /** Closes idle tunnels after this many milliseconds. */
  readonly idleTimeoutMs?: number
  /** Concurrent client sockets across all workspaces; excess connections are refused before any work. */
  readonly maxConnections?: number
}

const defaultResolve: Resolver = async host => (await lookup(host, { all: true, verbatim: true })).map(r => r.address)

interface Tunnel { readonly host: string; readonly port: number; readonly client: string | undefined; readonly sockets: readonly Socket[] }

/** A running proxy and its controls. */
export interface EgressProxy {
  readonly server: Server
  /** Re-evaluate open tunnels against the current policy and close refused ones. */
  reevaluate(): void
  close(): Promise<void>
}

async function admit(options: ProxyOptions, host: string, port: number, client: string | undefined): Promise<{ decision: Decision; address?: string }> {
  const policy = policyForClient(options.policy(), client)
  const first = decideRequest(policy, host, port)
  if (!first.allowed) return { decision: first }
  let addresses: string[]
  try {
    addresses = await (options.resolve ?? defaultResolve)(host.replace(/^\[|\]$/g, ''))
  } catch {
    return { decision: { allowed: false, reason: `cannot resolve ${host}` } }
  }
  if (addresses.length === 0) return { decision: { allowed: false, reason: `cannot resolve ${host}` } }
  for (const address of addresses) {
    const decision = decideAddress(policy, host, port, address)
    if (!decision.allowed) return { decision, address }
  }
  return { decision: { allowed: true }, address: addresses.find(a => !a.includes(':')) ?? addresses[0] }
}

function parseAuthority(authority: string): { host: string; port: number } | undefined {
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(authority)
  if (match === null) return undefined
  const port = Number(match[2])
  return port > 0 && port < 65536 ? { host: match[1]!, port } : undefined
}

/**
 * Start the proxy server (call `listen` on the returned server).
 * @param options - policy source, resolver and logger.
 * @returns proxy controls.
 */
export function createEgressProxy(options: ProxyOptions): EgressProxy {
  const tunnels = new Set<Tunnel>()
  const log = (event: Omit<EgressEvent, 'time'>): void => { options.log?.({ time: new Date().toISOString(), ...event }) }
  const idle = options.idleTimeoutMs ?? 10 * 60_000

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let url: URL
    try {
      url = new URL(req.url ?? '')
    } catch {
      res.writeHead(400).end('absolute URL required\n')
      return
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400).end('use CONNECT for TLS\n')
      return
    }
    const port = url.port === '' ? 80 : Number(url.port)
    void admit(options, url.hostname, port, req.socket.remoteAddress).then(({ decision, address }) => {
      log({ kind: 'http', host: url.hostname, port, allowed: decision.allowed, reason: decision.allowed ? undefined : decision.reason, address })
      if (!decision.allowed) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end(`[sandbox: network access to ${url.hostname} denied by the Code egress policy] ${decision.reason}. The agent can ask the user with the request_network_access tool.\n`)
        return
      }
      const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: url.host }
      delete headers['proxy-connection']
      delete headers['proxy-authorization']
      const upstream = httpRequest({ host: address, port, method: req.method, path: `${url.pathname}${url.search}`, headers, setHost: false }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      })
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy() })
      req.pipe(upstream)
    })
  })

  // Admission before work: a sandbox opening sockets in a loop cannot exhaust the proxy. Generous on purpose,
  // so parallel package installs in several workspaces still fit. Header size and deadline keep Node's defaults
  // (16 KiB, 60 s); tunnels close after the idle timeout, never on an absolute deadline that would cut downloads.
  server.maxConnections = options.maxConnections ?? 2048
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    const target = parseAuthority(req.url ?? '')
    client.on('error', () => { client.destroy() })
    if (target === undefined) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    void admit(options, target.host, target.port, client.remoteAddress).then(({ decision, address }) => {
      log({ kind: 'connect', host: target.host, port: target.port, allowed: decision.allowed, reason: decision.allowed ? undefined : decision.reason, address })
      if (!decision.allowed || address === undefined) {
        client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n[sandbox: network access to ${target.host} denied by the Code egress policy] ${decision.allowed ? 'no address' : decision.reason}. The agent can ask the user with the request_network_access tool.\n`)
        return
      }
      const upstream = connect({ host: address, port: target.port })
      const tunnel: Tunnel = { host: target.host, port: target.port, client: client.remoteAddress, sockets: [client, upstream] }
      tunnels.add(tunnel)
      const close = (): void => { tunnels.delete(tunnel); client.destroy(); upstream.destroy() }
      upstream.setTimeout(idle, close)
      client.setTimeout(idle, close)
      upstream.on('error', close)
      upstream.on('close', close)
      client.on('close', close)
      upstream.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
    })
  })

  return {
    server,
    reevaluate() {
      const policy = options.policy()
      for (const tunnel of tunnels) {
        if (!decideRequest(policyForClient(policy, tunnel.client), tunnel.host, tunnel.port).allowed) {
          tunnels.delete(tunnel)
          for (const socket of tunnel.sockets) socket.destroy()
        }
      }
    },
    close: () => new Promise((resolve) => {
      for (const tunnel of tunnels) for (const socket of tunnel.sockets) socket.destroy()
      tunnels.clear()
      server.close(() => { resolve() })
    }),
  }
}

/**
 * Container entry: read the policy file, listen, and reload on change.
 * @param policyPath - JSON policy path (mounted read-only).
 * @param port - listen port.
 */
export function main(policyPath: string, port: number): void {
  let policy = JSON.parse(readFileSync(policyPath, 'utf8')) as EgressPolicy
  const proxy = createEgressProxy({
    policy: () => policy,
    log: (event) => { process.stdout.write(`${JSON.stringify(event)}\n`) },
  })
  watchFile(policyPath, { interval: 1000 }, () => {
    try {
      policy = JSON.parse(readFileSync(policyPath, 'utf8')) as EgressPolicy
      proxy.reevaluate()
    } catch (error) {
      process.stderr.write(`policy reload failed; keeping previous policy: ${String(error)}\n`)
    }
  })
  proxy.server.listen(port, '0.0.0.0')
}
