/**
 * Client state owned by the Code plugin instance: the Code session ids known
 * to the Host, exposed as `HostObservable`s so slot components subscribe
 * through the renderer's standard hook binding.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** A small observable value with an owner-controlled setter. */
export interface Cell<T> extends HostObservable<T> {
  set(next: T): void
}

/**
 * Create a cell.
 * @param initial - initial value.
 * @param equal - change test.
 * @returns the cell.
 */
export function cell<T>(initial: T, equal: (a: T, b: T) => boolean = Object.is): Cell<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      if (equal(value, next)) return
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * Compare two id sets by membership.
 * @param a - first set.
 * @param b - second set.
 * @returns whether both hold the same ids.
 */
export function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}
