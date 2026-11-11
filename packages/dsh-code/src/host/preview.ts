/**
 * Application previews: an HTTP route on the Harness web server that proxies
 * to a declared port of a workspace container on the internal network. No
 * host port is ever published.
 *
 * The preview is untrusted content served from the Harness origin, so:
 * - access needs a short-lived capability token minted through the
 *   authenticated Code UI (`/dsh-code/preview/<token>/...`);
 * - every response carries `Content-Security-Policy: sandbox` without
 *   `allow-same-origin`, which gives the page an opaque origin: its scripts
 *   cannot read Harness storage, call Harness APIs with the user's cookie, or
 *   script the Harness window;
 * - the user's Cookie and Authorization headers never reach the container,
 *   and the container cannot set cookies on the Harness origin.
 */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'

/** Route prefix on the Harness web server. */
export const PREVIEW_PREFIX = '/dsh-code/preview'

/** Token lifetime. */
export const PREVIEW_TTL_MS = 8 * 60 * 60 * 1000

/** Policy applied to every proxied response. */
export const PREVIEW_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads'

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'])
const STRIP_REQUEST = new Set([...HOP_BY_HOP, 'cookie', 'authorization', 'origin', 'referer'])
const STRIP_RESPONSE = new Set([...HOP_BY_HOP, 'set-cookie', 'content-security-policy', 'content-security-policy-report-only', 'service-worker-allowed', 'clear-site-data', 'access-control-allow-origin', 'access-control-allow-credentials'])

interface Grant {
  readonly sessionId: string
  readonly port: number
  readonly expires: number
}

/** Resolves a session's preview port to an internal address. */
export type PreviewResolver = (sessionId: string, port: number) => Promise<{ host: string; port: number }>

/** Token registry and proxy handler. */
export class PreviewProxy {
  private readonly grants = new Map<string, Grant>()

  /**
   * @param resolve - maps a grant to the container address.
   * @param now - clock (tests).
   */
  constructor(private readonly resolve: PreviewResolver, private readonly now: () => number = Date.now) {}

  /**
   * Mint a preview path for one session port.
   * @param sessionId - logical session id.
   * @param port - declared container port.
   * @returns the same-origin path to open.
   */
  mint(sessionId: string, port: number): string {
    this.prune()
    const token = randomBytes(24).toString('base64url')
    this.grants.set(token, { sessionId, port, expires: this.now() + PREVIEW_TTL_MS })
    return `${PREVIEW_PREFIX}/${token}/`
  }

  /**
   * Revoke every grant of a session (workspace deleted or restarted elsewhere).
   * @param sessionId - logical session id.
   */
  revoke(sessionId: string): void {
    for (const [token, grant] of this.grants) if (grant.sessionId === sessionId) this.grants.delete(token)
  }

  /**
   * Handle one request under {@link PREVIEW_PREFIX}.
   * @param req - incoming request.
   * @param res - response.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://preview.invalid')
    const match = /^\/dsh-code\/preview\/([A-Za-z0-9_-]{32})(\/.*)?$/.exec(url.pathname)
    const grant = match === null ? undefined : this.grants.get(match[1]!)
    if (match === null || grant === undefined || grant.expires < this.now()) {
      if (match !== null) this.grants.delete(match[1]!)
      fail(res, 404, 'Preview link not found or expired. Open the preview again from the Code session.')
      return
    }
    let target: { host: string; port: number }
    try {
      target = await this.resolve(grant.sessionId, grant.port)
    } catch (error) {
      fail(res, 502, `Preview unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const base = `${PREVIEW_PREFIX}/${match[1]!}`
    const headers: Record<string, string | string[]> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined && !STRIP_REQUEST.has(key.toLowerCase())) headers[key] = value
    }
    headers.host = `localhost:${target.port}`
    headers['x-forwarded-prefix'] = base
    const upstream = httpRequest({
      host: target.host, port: target.port, method: req.method, path: `${match[2] ?? '/'}${url.search}`, headers,
    }, (answer) => {
      const out: Record<string, string | string[]> = {}
      for (const [key, value] of Object.entries(answer.headers)) {
        if (value !== undefined && !STRIP_RESPONSE.has(key.toLowerCase())) out[key] = value
      }
      const location = answer.headers.location
      if (typeof location === 'string') out.location = rewriteLocation(location, base, target.port)
      Object.assign(out, securityHeaders())
      res.writeHead(answer.statusCode ?? 502, out)
      answer.pipe(res)
    })
    upstream.setTimeout(60_000, () => { upstream.destroy(new Error('preview timed out')) })
    upstream.on('error', (error) => {
      if (res.headersSent) res.destroy(error)
      else fail(res, 502, `Preview unavailable: ${error.message}. Is the app listening on 0.0.0.0:${grant.port} in the workspace?`)
    })
    req.pipe(upstream)
  }

  private prune(): void {
    const now = this.now()
    for (const [token, grant] of this.grants) if (grant.expires < now) this.grants.delete(token)
  }
}

/** @returns headers that confine a proxied response. */
export function securityHeaders(): Record<string, string> {
  return {
    'content-security-policy': PREVIEW_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'x-frame-options': 'SAMEORIGIN',
  }
}

/**
 * Keep redirects inside the preview.
 * @param location - upstream Location header.
 * @param base - preview path prefix with token.
 * @param port - upstream port.
 * @returns rewritten Location.
 */
export function rewriteLocation(location: string, base: string, port: number): string {
  if (location.startsWith('/') && !location.startsWith('//')) return `${base}${location}`
  try {
    const url = new URL(location)
    if ((url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '0.0.0.0') && Number(url.port || 80) === port) {
      return `${base}${url.pathname}${url.search}${url.hash}`
    }
  } catch {
    // Relative redirects stay relative to the preview path.
  }
  return location
}

function fail(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...securityHeaders() })
  res.end(message)
}
