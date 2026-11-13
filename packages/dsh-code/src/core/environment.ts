/**
 * User-defined, non-secret environment variables of Code workspaces: defaults from Settings > Code and per-session
 * values from the Environment tab. Credential-like names are refused: the agent reads every value.
 */

/** Names that look like credentials; refused for user variables and never forwarded into a container. */
export const CREDENTIAL_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^DSH_|^DOCKER_|^SSH_AUTH_SOCK$/i
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A rejected line of a variable list. */
export class EnvironmentError extends Error {
  /** @param line - the offending line. @param reason - why it is refused. */
  constructor(readonly line: string, reason: string) {
    super(`"${line}": ${reason}`)
    this.name = 'EnvironmentError'
  }
}

/**
 * Parse `NAME=value` lines; blank lines and `#` comments are ignored, later names win.
 * @param lines - variable lines.
 * @returns the variables.
 * @throws EnvironmentError on a malformed or credential-like line.
 */
export function parseEnvironment(lines: readonly string[]): Record<string, string> {
  if (lines.length > 256) throw new EnvironmentError(String(lines.length), 'at most 256 variables')
  const out: Record<string, string> = {}
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    const name = eq < 0 ? line : line.slice(0, eq).trim()
    if (eq < 0) throw new EnvironmentError(line, 'expected NAME=value')
    if (!NAME.test(name)) throw new EnvironmentError(line, 'the name must be letters, digits and underscores, not starting with a digit')
    if (CREDENTIAL_NAME.test(name)) throw new EnvironmentError(line, 'credential-like names are not passed into a workspace')
    const value = line.slice(eq + 1)
    if (value.length > 4096 || /[\0\n\r]/.test(value)) throw new EnvironmentError(line, 'the value must be one line of at most 4096 characters')
    out[name] = value
  }
  return out
}

/**
 * Render variables back to lines.
 * @param env - variables.
 * @returns `NAME=value` lines.
 */
export function environmentLines(env: Readonly<Record<string, string>>): string[] {
  return Object.entries(env).map(([name, value]) => `${name}=${value}`)
}
