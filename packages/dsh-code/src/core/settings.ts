/**
 * Settings > Code: validation of the values the UI may change. These are
 * control-plane operations reached only through the authenticated Code UI;
 * nothing in a workspace or in the agent's tools can call them.
 */
import { normalizeHost } from '../egress/policy.ts'
import type { CodeSettings } from '../types.ts'
import { environmentLines, EnvironmentError, parseEnvironment } from './environment.ts'
import { unsafeFolderReason } from './mounts.ts'

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
  if (!Array.isArray(input.disabledAccounts) || input.disabledAccounts.length > 64) throw new SettingsError('disabledAccounts', 'must be a list of at most 64 GitHub logins')
  const disabledAccounts = [...new Set(input.disabledAccounts.map((login) => {
    if (typeof login !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) throw new SettingsError('disabledAccounts', `"${String(login)}" is not a GitHub login`)
    return login
  }))]
  if (typeof input.newBranch !== 'boolean') throw new SettingsError('newBranch', 'must be true or false')
  for (const field of ['readOnlyWorkspace', 'dependencyCache', 'lockdown', 'previewEnabled'] as const) {
    if (typeof input[field] !== 'boolean') throw new SettingsError(field, 'must be true or false')
  }
  if (!Array.isArray(input.readOnlyFolders) || input.readOnlyFolders.length > 32) throw new SettingsError('readOnlyFolders', 'must be a list of at most 32 folders')
  const readOnlyFolders = [...new Set(input.readOnlyFolders.map((folder) => {
    const reason = typeof folder === 'string' ? unsafeFolderReason(folder) : 'must be a path'
    if (reason !== undefined) throw new SettingsError('readOnlyFolders', `"${String(folder)}": ${reason}`)
    return folder
  }))]
  if (!Array.isArray(input.environment)) throw new SettingsError('environment', 'must be a list of NAME=value lines')
  let environment: string[]
  try {
    environment = environmentLines(parseEnvironment(input.environment))
  } catch (error) {
    throw new SettingsError('environment', error instanceof EnvironmentError ? error.message : String(error))
  }
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
    disabledAccounts,
    newBranch: input.newBranch,
    shmMb: number('shmMb', input.shmMb, 16, 65536),
    readOnlyWorkspace: input.readOnlyWorkspace,
    dependencyCache: input.dependencyCache,
    readOnlyFolders,
    environment,
    lockdown: input.lockdown,
    previewEnabled: input.previewEnabled,
  }
}

/** Config fields Settings > Code edits; all apply without restarting Harness. */
export const SETTINGS_FIELDS = ['network', 'allow', 'privateAllow', 'ports', 'cpus', 'memoryMb', 'pids', 'tmpMb', 'maxWorkspaces', 'workerImage', 'previewPorts', 'disabledAccounts', 'newBranch', 'shmMb', 'readOnlyWorkspace', 'dependencyCache', 'readOnlyFolders', 'environment', 'lockdown', 'previewEnabled'] as const satisfies ReadonlyArray<keyof CodeSettings>

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
