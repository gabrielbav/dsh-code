/**
 * Builds the `docker create` argv for one session workspace container. The
 * security defaults are fixed invariants, not tunables: gVisor runtime,
 * dropped capabilities, no-new-privileges, read-only root, no Docker socket,
 * and a single bind mount of the session's own workspace directory at the
 * same absolute path. Resource limits and the image are deployment choices.
 */

/** The only runtime dsh-code accepts. There is no fallback. */
export const REQUIRED_RUNTIME = 'runsc'

/** Label marking containers owned by dsh-code. */
export const OWNER_LABEL = 'io.github.gabrielbav.dsh-code'
/** Label carrying the logical Code session id. */
export const SESSION_LABEL = `${OWNER_LABEL}.session`
/** Label carrying the workspace id. */
export const WORKSPACE_LABEL = `${OWNER_LABEL}.workspace`

/** Resource limits for one workspace container. */
export interface ResourceLimits {
  readonly cpus: number
  readonly memoryMb: number
  readonly pids: number
  /** Writable tmpfs size for /tmp, in MB. */
  readonly tmpMb: number
}

/** Everything needed to create one workspace container. */
export interface ContainerSpec {
  readonly name: string
  /** Value of the owner label; the manager's namespace marks which manager owns the container. */
  readonly owner?: string
  readonly image: string
  readonly sessionId: string
  readonly workspaceId: string
  /** Absolute host path of the session checkout; mounted at the same path. */
  readonly workspacePath: string
  /** Internal network with no route except the egress proxy. */
  readonly network: string
  /** Proxy URL inside the network, e.g. `http://dsh-code-egress:3128`; undefined means no external access. */
  readonly proxyUrl: string | undefined
  readonly uid: number
  readonly gid: number
  readonly limits: ResourceLimits
  /** Static host entries (the proxy), since the worker has no DNS. */
  readonly hosts?: Readonly<Record<string, string>>
  /** Extra non-secret environment variables. */
  readonly env?: Readonly<Record<string, string>>
  /** Mount the checkout read-only: the agent can read and run, but not change files. */
  readonly readOnlyWorkspace?: boolean
  /** Host directory for this repository's dependency caches, mounted read-write at {@link CACHE_TARGET}. */
  readonly cacheDir?: string
  /** Extra host folders mounted read-only at the same path; already checked with unsafeFolderReason. */
  readonly readOnlyFolders?: readonly string[]
  /** Size of /dev/shm in MB (headless browsers need more than Docker's 64 MB). */
  readonly shmMb?: number
}

/** Where a repository's dependency cache is mounted inside the container. */
export const CACHE_TARGET = '/opt/dsh-cache'

/** Variables that point package managers at {@link CACHE_TARGET}. */
export function cacheEnvironment(): Record<string, string> {
  return {
    XDG_CACHE_HOME: `${CACHE_TARGET}/xdg`, NPM_CONFIG_CACHE: `${CACHE_TARGET}/npm`, YARN_CACHE_FOLDER: `${CACHE_TARGET}/yarn`,
    PIP_CACHE_DIR: `${CACHE_TARGET}/pip`, UV_CACHE_DIR: `${CACHE_TARGET}/uv`, GOMODCACHE: `${CACHE_TARGET}/go/mod`, GOCACHE: `${CACHE_TARGET}/go/build`,
    CARGO_HOME: `${CACHE_TARGET}/cargo`, GRADLE_USER_HOME: `${CACHE_TARGET}/gradle`, BUN_INSTALL_CACHE_DIR: `${CACHE_TARGET}/bun`,
  }
}

/**
 * Validate a spec at the process boundary before it reaches Docker.
 * @param spec - container spec.
 * @throws Error when a field would weaken isolation or is malformed.
 */
export function validateSpec(spec: ContainerSpec): void {
  if (!spec.workspacePath.startsWith('/') || spec.workspacePath.split('/').includes('..')) {
    throw new Error(`workspace path must be absolute and normalized: ${spec.workspacePath}`)
  }
  if (spec.workspacePath === '/' || /^\/(home|root|Users)\/?[^/]*\/?$/.test(spec.workspacePath)) {
    throw new Error(`refusing to mount a home or root directory: ${spec.workspacePath}`)
  }
  if (spec.uid === 0) throw new Error('workspace containers must not run as root')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(spec.name)) throw new Error(`invalid container name: ${spec.name}`)
  for (const [key, value] of [['cpus', spec.limits.cpus], ['memoryMb', spec.limits.memoryMb], ['pids', spec.limits.pids], ['tmpMb', spec.limits.tmpMb]] as const) {
    if (!(value > 0) || !Number.isFinite(value)) throw new Error(`limit ${key} must be a positive number`)
  }
  const absolute = (path: string): boolean => path.startsWith('/') && !path.split('/').includes('..')
  if (spec.cacheDir !== undefined && (!absolute(spec.cacheDir) || spec.cacheDir.startsWith(`${spec.workspacePath}/`))) throw new Error(`invalid cache folder: ${spec.cacheDir}`)
  for (const folder of spec.readOnlyFolders ?? []) {
    if (!absolute(folder) || folder === spec.workspacePath || folder.startsWith(`${spec.workspacePath}/`) || spec.workspacePath.startsWith(`${folder}/`)) throw new Error(`invalid read-only folder: ${folder}`)
  }
  if (spec.shmMb !== undefined && !(spec.shmMb >= 16 && spec.shmMb <= 65536)) throw new Error('shared memory must be 16 to 65536 MB')
  for (const key of Object.keys(spec.env ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`invalid environment name: ${key}`)
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/.test(key)) throw new Error(`refusing to pass a credential-like variable into a workspace: ${key}`)
  }
}

/**
 * Build the `docker create` argv. The container's init keeps it alive so
 * every tool call runs through `docker exec` in the same sandbox.
 * @param spec - validated container spec.
 * @returns argv after `docker`.
 */
export function createArgs(spec: ContainerSpec): string[] {
  validateSpec(spec)
  const env: Record<string, string> = {
    HOME: '/tmp/home',
    ...spec.cacheDir === undefined ? {} : cacheEnvironment(),
    ...spec.env,
  }
  if (spec.proxyUrl !== undefined) {
    Object.assign(env, {
      HTTPS_PROXY: spec.proxyUrl, HTTP_PROXY: spec.proxyUrl, https_proxy: spec.proxyUrl, http_proxy: spec.proxyUrl,
      NO_PROXY: '', no_proxy: '',
    })
  }
  const args = [
    'create',
    '--name', spec.name,
    '--runtime', REQUIRED_RUNTIME,
    '--label', `${OWNER_LABEL}=${spec.owner ?? '1'}`,
    '--label', `${SESSION_LABEL}=${spec.sessionId}`,
    '--label', `${WORKSPACE_LABEL}=${spec.workspaceId}`,
    '--user', `${spec.uid}:${spec.gid}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', `/tmp:rw,nosuid,nodev,size=${spec.limits.tmpMb}m`,
    '--cpus', String(spec.limits.cpus),
    '--memory', `${spec.limits.memoryMb}m`,
    '--memory-swap', `${spec.limits.memoryMb}m`,
    '--pids-limit', String(spec.limits.pids),
    '--network', spec.network,
    // The worker resolves nothing itself; the egress proxy resolves names.
    // Pointing DNS at an unroutable address blocks DNS tunnelling.
    '--dns', '127.0.0.1',
    '--mount', `type=bind,source=${spec.workspacePath},target=${spec.workspacePath}${spec.readOnlyWorkspace === true ? ',readonly' : ''}`,
    '--workdir', spec.workspacePath,
    '--init',
  ]
  if (spec.shmMb !== undefined) args.push('--shm-size', `${spec.shmMb}m`)
  if (spec.cacheDir !== undefined) args.push('--mount', `type=bind,source=${spec.cacheDir},target=${CACHE_TARGET}`)
  for (const folder of spec.readOnlyFolders ?? []) args.push('--mount', `type=bind,source=${folder},target=${folder},readonly`)
  for (const [host, address] of Object.entries(spec.hosts ?? {})) args.push('--add-host', `${host}:${address}`)
  for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`)
  args.push(spec.image, 'sleep', 'infinity')
  return args
}

/**
 * Build `docker exec` argv for one process inside a workspace container.
 * @param container - container name or id.
 * @param argv - program and arguments.
 * @param cwd - working directory inside the container.
 * @param env - environment for the process.
 * @param tty - allocate a terminal.
 * @returns argv after `docker`.
 */
export function execArgs(
  container: string,
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
  tty: boolean,
): string[] {
  if (argv.length === 0) throw new Error('exec argv must not be empty')
  const args = ['exec', '-i']
  if (tty) args.push('-t')
  args.push('-w', cwd)
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`)
  args.push(container, ...argv)
  return args
}
