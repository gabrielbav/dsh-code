/**
 * Egress policy evaluation for the trusted proxy. Pure functions: hostname
 * allowlist matching and resolved-address classification. The proxy applies
 * both — the hostname at request time and every resolved address before it
 * connects — so DNS rebinding, direct-IP requests and private ranges are
 * refused outside the worker.
 */
import { isIP } from 'node:net'

/** Network policy modes from Settings > Code > Network. */
export type EgressMode = 'allowlist' | 'none' | 'open'

/** Policy the proxy enforces. Changes are control-plane operations only. */
export interface EgressPolicy {
  readonly mode: EgressMode
  /** Hostname patterns: `example.com` (exact) or `*.example.com` (subdomains only). */
  readonly allow: readonly string[]
  /** Private destinations the user explicitly approved, as `host:port`. */
  readonly privateAllow: readonly string[]
  /** Allowed destination ports. */
  readonly ports: readonly number[]
  /**
   * Extra host patterns per workspace, keyed by the container's address on the internal network: hosts the user
   * approved for one Code session through the request_network_access tool. Other sessions never get them.
   */
  readonly clients?: Readonly<Record<string, readonly string[]>>
}

/**
 * The policy one client (a workspace container) gets: the shared allowlist plus that session's approved hosts.
 * @param policy - the shared policy.
 * @param client - the client's address as the proxy sees it (IPv4-mapped IPv6 is accepted).
 * @returns the policy to decide this client's requests.
 */
export function policyForClient(policy: EgressPolicy, client: string | undefined): EgressPolicy {
  const address = client?.replace(/^::ffff:/i, '')
  const extra = address === undefined ? undefined : policy.clients?.[address]
  return extra === undefined || extra.length === 0 ? policy : { ...policy, allow: [...policy.allow, ...extra] }
}

/** Default approved destinations: source control and common package registries. */
export const DEFAULT_ALLOW: readonly string[] = [
  'github.com', '*.github.com', '*.githubusercontent.com',
  'registry.npmjs.org', 'registry.yarnpkg.com',
  'pypi.org', 'files.pythonhosted.org',
  'proxy.golang.org', 'sum.golang.org',
  'crates.io', 'index.crates.io', 'static.crates.io',
  'repo.maven.apache.org', 'repo1.maven.org',
]

/** Decision with a reason the user can read. */
export type Decision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string }

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

/**
 * Normalize and validate a requested hostname.
 * @param host - raw host from CONNECT or an absolute URL.
 * @returns lowercase hostname without a trailing dot, or undefined when invalid.
 */
export function normalizeHost(host: string): string | undefined {
  const lowered = host.trim().toLowerCase().replace(/\.$/, '')
  return HOSTNAME.test(lowered) ? lowered : undefined
}

/**
 * Match a hostname against one allowlist pattern.
 * @param host - normalized hostname.
 * @param pattern - `example.com` or `*.example.com`.
 * @returns whether the pattern admits the host.
 */
export function matchesPattern(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase()
  if (p.startsWith('*.')) return host.endsWith(p.slice(1)) && host.length > p.length - 1
  return host === p
}

/**
 * Decide a requested destination before name resolution.
 * @param policy - the active policy.
 * @param rawHost - requested host.
 * @param port - requested port.
 * @returns the decision.
 */
export function decideRequest(policy: EgressPolicy, rawHost: string, port: number): Decision {
  if (policy.mode === 'none') return { allowed: false, reason: 'external network access is disabled for Code sessions' }
  if (isIP(rawHost.replace(/^\[|\]$/g, '')) !== 0) {
    const literal = rawHost.replace(/^\[|\]$/g, '')
    if (policy.privateAllow.includes(`${literal}:${port}`)) return { allowed: true }
    return { allowed: false, reason: `direct IP destinations are blocked: ${rawHost}` }
  }
  const host = normalizeHost(rawHost)
  if (host === undefined) return { allowed: false, reason: `invalid host: ${rawHost}` }
  if (policy.privateAllow.includes(`${host}:${port}`)) return { allowed: true }
  if (!policy.ports.includes(port)) return { allowed: false, reason: `port ${port} is not allowed` }
  if (policy.mode === 'open') return { allowed: true }
  return policy.allow.some(pattern => matchesPattern(host, pattern))
    ? { allowed: true }
    : { allowed: false, reason: `${host} is not an approved destination` }
}

function ipv4ToInt(address: string): number {
  return address.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0
}

const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]

/**
 * Whether a resolved address is private, loopback, link-local (including
 * cloud metadata), reserved, or IPv6. IPv6 is refused entirely because the
 * worker network is IPv4-only; refusing it closes IPv6 bypass routes.
 * @param address - resolved IP literal.
 * @returns true when the proxy must not connect to it.
 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
    return mapped === null ? true : isBlockedAddress(mapped[1]!)
  }
  if (family !== 4) return true
  const value = ipv4ToInt(address)
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
    return (value & mask) === (ipv4ToInt(base) & mask)
  })
}

/**
 * Decide a resolved address for an already-admitted request.
 * @param policy - the active policy.
 * @param host - requested host as admitted.
 * @param port - requested port.
 * @param address - resolved IP.
 * @returns the decision.
 */
export function decideAddress(policy: EgressPolicy, host: string, port: number, address: string): Decision {
  if (!isBlockedAddress(address)) return { allowed: true }
  if (policy.privateAllow.includes(`${host}:${port}`) || policy.privateAllow.includes(`${address}:${port}`)) return { allowed: true }
  return { allowed: false, reason: `${host} resolved to a private or reserved address (${address})` }
}
