import { describe, expect, it } from 'vitest'
import { allowedUrl, parseBrowserInput } from '../src/worker/browser-protocol.ts'

describe('isolated browser protocol', () => {
  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'devtools://devtools', 'data:text/html,x', 'about:blank', 'not a url', 42])('refuses navigating to %s', (url) => {
    expect(allowedUrl(url)).toBeUndefined()
    expect(parseBrowserInput({ kind: 'navigate', url })).toBeUndefined()
  })

  it('accepts http(s) pages', () => {
    expect(parseBrowserInput({ kind: 'navigate', url: 'http://127.0.0.1:8000/a?b' })).toEqual({ kind: 'navigate', url: 'http://127.0.0.1:8000/a?b' })
  })

  it('drops anything outside the protocol and clamps values', () => {
    expect(parseBrowserInput({ kind: 'Runtime.evaluate', expression: 'x' })).toBeUndefined()
    expect(parseBrowserInput(null)).toBeUndefined()
    expect(parseBrowserInput({ kind: 'resize', width: 99999, height: -5 })).toEqual({ kind: 'resize', width: 2560, height: 240 })
    expect(parseBrowserInput({ kind: 'mouse', event: 'evil', x: 1e9, y: 'a', button: 'x', clickCount: 9, modifiers: 99 }))
      .toEqual({ kind: 'mouse', event: 'mouseMoved', x: 4000, y: 0, button: 'none', clickCount: 3, modifiers: 15 })
    expect(parseBrowserInput({ kind: 'key', event: 'keyDown', key: 'a'.repeat(100), code: 'KeyA', text: 'abcdef', keyCode: 65, modifiers: 0 }))
      .toMatchObject({ key: 'a'.repeat(32), text: 'abcd' })
    expect(parseBrowserInput({ kind: 'history', action: 'rm -rf' })).toEqual({ kind: 'history', action: 'reload' })
  })
})
