/**
 * Wire protocol between the host and the browser bridge inside a Code workspace: JSON lines over `docker exec`
 * stdin/stdout. The bridge is the only party speaking Chrome DevTools Protocol, and only for the actions listed
 * here, so neither the host nor the viewer's browser ever gets raw control of Chromium.
 */

/** One action from the viewer, after validation. */
export type BrowserInput =
  | { readonly kind: 'navigate'; readonly url: string }
  | { readonly kind: 'history'; readonly action: 'back' | 'forward' | 'reload' }
  | { readonly kind: 'resize'; readonly width: number; readonly height: number }
  | { readonly kind: 'mouse'; readonly event: 'mousePressed' | 'mouseReleased' | 'mouseMoved'; readonly x: number; readonly y: number; readonly button: 'none' | 'left' | 'middle' | 'right'; readonly clickCount: number; readonly modifiers: number }
  | { readonly kind: 'wheel'; readonly x: number; readonly y: number; readonly deltaX: number; readonly deltaY: number; readonly modifiers: number }
  | { readonly kind: 'key'; readonly event: 'keyDown' | 'keyUp' | 'char'; readonly key: string; readonly code: string; readonly text: string; readonly keyCode: number; readonly modifiers: number }

/** One message from the bridge. */
export type BrowserOutput =
  | { readonly type: 'frame'; readonly data: string; readonly width: number; readonly height: number }
  | { readonly type: 'url'; readonly url: string }
  | { readonly type: 'ready' }
  | { readonly type: 'error'; readonly message: string }

const clamp = (value: unknown, min: number, max: number): number => {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return Math.min(max, Math.max(min, n))
}
const short = (value: unknown, max: number): string => typeof value === 'string' ? value.slice(0, max) : ''
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.includes(value as T) ? value as T : fallback

/**
 * Only http(s) pages; never file:, chrome:, devtools:, data: or javascript: URLs.
 * @param raw - requested URL.
 * @returns the normalized URL, or undefined when refused.
 */
export function allowedUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 2048) return undefined
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/**
 * Validate one viewer action; anything not in the protocol is dropped.
 * @param raw - parsed JSON.
 * @returns the action, or undefined when refused.
 */
export function parseBrowserInput(raw: unknown): BrowserInput | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const input = raw as Record<string, unknown>
  switch (input.kind) {
    case 'navigate': {
      const url = allowedUrl(input.url)
      return url === undefined ? undefined : { kind: 'navigate', url }
    }
    case 'history': return { kind: 'history', action: oneOf(input.action, ['back', 'forward', 'reload'] as const, 'reload') }
    case 'resize': return { kind: 'resize', width: Math.round(clamp(input.width, 320, 2560)), height: Math.round(clamp(input.height, 240, 1600)) }
    case 'mouse': return {
      kind: 'mouse', event: oneOf(input.event, ['mousePressed', 'mouseReleased', 'mouseMoved'] as const, 'mouseMoved'),
      x: clamp(input.x, 0, 4000), y: clamp(input.y, 0, 4000), button: oneOf(input.button, ['none', 'left', 'middle', 'right'] as const, 'none'),
      clickCount: Math.round(clamp(input.clickCount, 0, 3)), modifiers: Math.round(clamp(input.modifiers, 0, 15)),
    }
    case 'wheel': return {
      kind: 'wheel', x: clamp(input.x, 0, 4000), y: clamp(input.y, 0, 4000),
      deltaX: clamp(input.deltaX, -5000, 5000), deltaY: clamp(input.deltaY, -5000, 5000), modifiers: Math.round(clamp(input.modifiers, 0, 15)),
    }
    case 'key': return {
      kind: 'key', event: oneOf(input.event, ['keyDown', 'keyUp', 'char'] as const, 'keyDown'),
      key: short(input.key, 32), code: short(input.code, 32), text: short(input.text, 4), keyCode: Math.round(clamp(input.keyCode, 0, 255)), modifiers: Math.round(clamp(input.modifiers, 0, 15)),
    }
    default: return undefined
  }
}
