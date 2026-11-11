/**
 * Settings > Code: validation of the values the UI may change. These are
 * control-plane operations reached only through the authenticated Code UI;
 * nothing in a workspace or in the agent's tools can call them.
 */
import { normalizeHost } from '../egress/policy.ts'
import type { CodeSettings } from '../types.ts'

/** Structured validation failure naming the field. */
export class SettingsError extends Error {
  /**
   * @param field - offending field.
   * @param message - what is wrong.
   */
  constructor(readonly field: keyof CodeSettings, message: string) {
    super(`${field}: ${message}`)
    this.name = 'SettingsError'
  }
}

const IMAGE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[\w][\w.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$|^[a-z0-9.-]+(?::\d+)?\/[a-z0-9._/-]+(?::[\w][\w.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/

function number(field: keyof CodeSettings, value: unknown, min: number, max: number, integer = true): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new SettingsError(field, `must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`)
  }
  return value
}

function ports(field: keyof CodeSettings, value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 64) throw new SettingsError(field, 'must be a list of at most 64 ports')
  return [...new Set(value.map(port => number(field, port, 1, 65535)))].sort((a, b) => a - b)
}

/**
 * Validate and normalize settings from the UI.
 * @param input - untrusted settings.
 * @returns normalized settings.
 * @throws SettingsError for the first invalid field.
 */
export function validateSettings(input: CodeSettings): CodeSettings {
  if (input.network !== 'allowlist' && input.network !== 'none' && input.network !== 'open') throw new SettingsError('network', 'must be allowlist, none or open')
  if (!Array.isArray(input.allow) || input.allow.length > 512) throw new SettingsError('allow', 'must be a list of at most 512 host names')
  const allow = [...new Set(input.allow.map((pattern) => {
    const wildcard = typeof pattern === 'string' && pattern.startsWith('*.')
    const host = typeof pattern === 'string' ? normalizeHost(wildcard ? pattern.slice(2) : pattern) : undefined
    if (host === undefined || /^\d+(\.\d+){3}$/.test(host)) throw new SettingsError('allow', `"${String(pattern)}" is not a host name or *.domain pattern`)
    return wildcard ? `*.${host}` : host
  }))]
  if (!Array.isArray(input.privateAllow) || input.privateAllow.length > 64) throw new SettingsError('privateAllow', 'must be a list of at most 64 host:port entries')
  const privateAllow = [...new Set(input.privateAllow.map((entry) => {
    const match = typeof entry === 'string' ? /^([^:\s]+):(\d{1,5})$/.exec(entry.trim()) : null
    if (match === null || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new SettingsError('privateAllow', `"${String(entry)}" is not host:port`)
    return `${match[1]!.toLowerCase()}:${Number(match[2])}`
  }))]
  if (typeof input.workerImage !== 'string' || !IMAGE.test(input.workerImage)) throw new SettingsError('workerImage', 'is not a Docker image reference')
  return {
    network: input.network,
    allow,
    privateAllow,
    ports: ports('ports', input.ports),
    cpus: number('cpus', input.cpus, 0.25, 128, false),
    memoryMb: number('memoryMb', input.memoryMb, 256, 1024 * 1024),
    pids: number('pids', input.pids, 64, 1 << 20),
    tmpMb: number('tmpMb', input.tmpMb, 16, 1024 * 1024),
    maxWorkspaces: number('maxWorkspaces', input.maxWorkspaces, 1, 1024),
    workerImage: input.workerImage,
    previewPorts: ports('previewPorts', input.previewPorts),
  }
}

/** Config fields Settings > Code edits; all apply without restarting Harness. */
export const SETTINGS_FIELDS = ['network', 'allow', 'privateAllow', 'ports', 'cpus', 'memoryMb', 'pids', 'tmpMb', 'maxWorkspaces', 'workerImage', 'previewPorts'] as const satisfies ReadonlyArray<keyof CodeSettings>

/**
 * Whether two configs differ only in live-applicable settings.
 * @param current - running config.
 * @param next - candidate config.
 * @returns true when every other field is unchanged.
 */
export function onlySettingsChanged(current: object, next: object): boolean {
  const live = new Set<string>(SETTINGS_FIELDS)
  const keys = new Set([...Object.keys(current), ...Object.keys(next)])
  for (const key of keys) {
    if (live.has(key)) continue
    if (JSON.stringify((current as Record<string, unknown>)[key]) !== JSON.stringify((next as Record<string, unknown>)[key])) return false
  }
  return true
}
