/**
 * Workspace lifecycle for Code sessions, independent of Harness: gVisor
 * validation, the internal network and egress proxy, per-session checkout
 * and container provisioning, in-container Git status, reconciliation after
 * restarts, and cleanup. One session owns exactly one workspace and one
 * container; the logical session id is never the container id.
 */
import { chown, constants, cp, lchown, mkdir, open, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { DockerCli } from './docker.ts'
import { createArgs, execArgs, OWNER_LABEL, REQUIRED_RUNTIME, SESSION_LABEL, type ResourceLimits } from './container-spec.ts'
import { unsafeFolderReason } from './mounts.ts'
import { Git, workingBranchName } from './git.ts'
import type { RepositoryRef, SelfTestCheck, SelfTestReport, WorkspaceStatus, WorkspaceUsage } from '../types.ts'

export type { SelfTestReport, WorkspaceStatus } from '../types.ts'
import type { EgressPolicy } from '../egress/policy.ts'

/** Durable workspace record, stored as JSON in the data directory. */
export interface WorkspaceRecord {
  readonly workspaceId: string
  readonly sessionId: string
  readonly repository: RepositoryRef
  /** GitHub account that clones and pushes; absent means the gh CLI's active account. */
  readonly account?: string
  readonly baseBranch: string
  readonly baseCommit: string
  readonly workingBranch: string
  /** Sandbox options the current container was created with. */
  options?: WorkspaceOptions
  readonly path: string
  readonly mirrorPath: string
  readonly containerName: string
  readonly image: string
  readonly runtime: typeof REQUIRED_RUNTIME
  status: WorkspaceStatus
  error?: string
  readonly createdAt: string
  updatedAt: string
}

/** Relay run by `node -e` inside the container: stdin/stdout <-> 127.0.0.1:<port>. */
const PREVIEW_RELAY = "const s=require('net').connect(+process.argv[1],'127.0.0.1');process.stdin.pipe(s);s.pipe(process.stdout);s.on('error',()=>process.exit(1));s.on('close',()=>process.exit(0));process.stdin.on('end',()=>s.end())"

/** One TCP port a workspace process listens on. */
export interface ListeningPort {
  readonly port: number
  /** Bound to 127.0.0.1 or ::1 only, so the preview, which reaches the container over its network, cannot connect. */
  readonly localOnly: boolean
}

/**
 * Listening sockets from /proc/net/tcp and /proc/net/tcp6 text (state 0A).
 * @param text - the concatenated files.
 * @returns one entry per port; local-only when every socket on it is loopback-bound.
 */
export function parseListeningPorts(text: string): ListeningPort[] {
  const ports = new Map<number, boolean>()
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 4 || fields[3] !== '0A') continue
    const [address, hexPort] = (fields[1] ?? '').split(':')
    const port = Number.parseInt(hexPort ?? '', 16)
    if (!Number.isInteger(port) || port <= 0 || address === undefined) continue
    // Little-endian hex: 127.x.x.x ends in 7F; ::1 is 0...01000000; ::ffff:127.x is 0000000000000000FFFF0000xx00007F.
    const loopback = (address.length === 8 && address.endsWith('7F')) || address === '00000000000000000000000001000000' || /^0000000000000000FFFF0000[0-9A-F]{6}7F$/i.test(address)
    ports.set(port, (ports.get(port) ?? true) && loopback)
  }
  return [...ports].map(([port, localOnly]) => ({ port, localOnly })).sort((a, b) => a.port - b.port)
}

/** Sandbox options applied when a workspace container is created. */
export interface WorkspaceOptions {
  readonly readOnlyWorkspace: boolean
  /** Host folder of this repository's dependency cache, when the cache is on. */
  readonly cacheDir?: string
  readonly readOnlyFolders: readonly string[]
  readonly shmMb: number
  readonly lockdown: boolean
}

/** Deployment configuration for the manager. */
export interface WorkspaceManagerConfig {
  /** Root for workspaces, mirrors and records; must be outside any home dotfolder. */
  readonly dataDir: string
  /** Worker image reference, pinned by digest in production. */
  image: string
  /** Directory holding the worker Dockerfile and file helper, for guided builds. */
  readonly workerDir?: string
  /** Egress proxy image (runs the bundled proxy script). */
  readonly proxyImage: string
  /** Absolute host directory holding the egress proxy sources (`entry.ts`, `proxy.ts`, `policy.ts`). */
  readonly proxyDir: string
  limits: ResourceLimits
  policy: EgressPolicy
  /** Container uid/gid; must not be 0. */
  readonly uid: number
  readonly gid: number
  /** Maximum concurrent workspaces on this host. */
  maxWorkspaces: number
  /** Container ports the user may preview through the authenticated Harness route. */
  previewPorts: readonly number[]
  /** New `dsh-code/<hash>` branch per session (default); false works on the base branch itself. */
  newBranch?: boolean
  /** Mount checkouts read-only. */
  readOnlyWorkspace?: boolean
  /** Keep a dependency cache per repository under dataDir/caches. */
  dependencyCache?: boolean
  /** Extra host folders mounted read-only at the same path. */
  readOnlyFolders?: readonly string[]
  /** /dev/shm size in MB; 256 when unset. */
  shmMb?: number
  /** Forces a read-only workspace, no cache and no extra folders (network none is applied through the policy). */
  lockdown?: boolean
  /** Default variables for every workspace; a session's own values override them by name. */
  environment?: Readonly<Record<string, string>>
  /**
   * Prefix of every Docker name and the owner label value this manager uses. Two managers with
   * different namespaces never see or remove each other's containers and networks (the live tests
   * rely on this). Defaults to `dsh-code`, which keeps the names and labels of existing installs.
   */
  readonly namespace?: string
}

/** Structured failure with a user-actionable code. */
export class WorkspaceError extends Error {
  /**
   * @param code - stable failure code.
   * @param message - localized-by-caller detail.
   */
  constructor(readonly code: 'gvisor-unavailable' | 'docker-unavailable' | 'limit-reached' | 'not-found' | 'provision-failed' | 'unsafe-state', message: string) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

/** Network and proxy names. Fixed: they are the isolation invariant's anchors. */
/** Default namespace; its owner label value stays `1` so earlier installs keep their containers. */
export const DEFAULT_NAMESPACE = 'dsh-code'
export const PROXY_PORT = 3128

/** Owns workspace records and their Docker resources. */
export class WorkspaceManager {
  private readonly records = new Map<string, WorkspaceRecord>()
  private readonly pending = new Map<string, Promise<WorkspaceRecord>>()

  /**
   * @param config - deployment configuration.
   * @param docker - Docker CLI.
   * @param git - host Git.
   */
  constructor(
    readonly config: WorkspaceManagerConfig,
    private readonly docker = new DockerCli(),
    private readonly git = new Git(),
    /** Host-only environment that makes git act as one GitHub account; never reaches a workspace. */
    private readonly credentials: (account: string) => Promise<Readonly<Record<string, string>>> = async () => ({}),
  ) {
    if (config.uid === 0 || config.gid === 0) throw new WorkspaceError('unsafe-state', 'workspace uid/gid must not be 0')
  }

  private get namespace(): string { return this.config.namespace ?? DEFAULT_NAMESPACE }
  private get owner(): string { return this.namespace === DEFAULT_NAMESPACE ? '1' : this.namespace }
  /** Internal network: workers and the proxy only, no route out. */
  get internalNetwork(): string { return `${this.namespace}-internal` }
  /** Network the proxy uses to reach the outside. */
  get egressNetwork(): string { return `${this.namespace}-egress-out` }
  /** The egress proxy container, also its DNS alias on the internal network. */
  get proxyContainer(): string { return `${this.namespace}-egress` }
  private get recordsDir(): string { return join(this.config.dataDir, 'records') }
  private get policyPath(): string { return join(this.config.dataDir, 'egress', 'policy.json') }
  /**
   * The proxy's code, copied into the data directory before each start. The Docker host may not see the
   * plugin's install folder (on macOS, a Colima VM cannot read ~/Documents), but it must see dataDir for
   * the workspaces anyway. The copy is outside `workspaces/`, so no sandbox can write to it.
   */
  private get proxySourceDir(): string { return join(this.config.dataDir, 'proxy') }

  /**
   * Run the mandatory checks. Code stays disabled unless every check passes.
   * @returns the report.
   */
  async selfTest(): Promise<SelfTestReport> {
    const checks: SelfTestCheck[] = []
    const runtimes = await this.docker.runtimes()
    checks.push(runtimes.length > 0
      ? { id: 'docker', ok: true, detail: 'Docker daemon reachable' }
      : { id: 'docker', ok: false, detail: 'Docker daemon not reachable', remedy: SETUP_REMEDIES.docker })
    if (runtimes.length === 0) return { ok: false, checks }
    const hasRunsc = runtimes.includes(REQUIRED_RUNTIME)
    checks.push(hasRunsc
      ? { id: 'runtime', ok: true, detail: 'runsc runtime registered' }
      : { id: 'runtime', ok: false, detail: 'runsc runtime is not registered with Docker', remedy: SETUP_REMEDIES.runtime })
    const image = await this.docker.tryExec(['image', 'inspect', '--format', '{{.Id}}', this.config.image])
    checks.push(image.code === 0
      ? { id: 'image', ok: true, detail: `worker image ${this.config.image} present (${image.stdout.trim().slice(0, 19)})` }
      : { id: 'image', ok: false, detail: `worker image ${this.config.image} is missing`, remedy: SETUP_REMEDIES.image(this.config.image), ...(this.config.workerDir === undefined ? {} : { action: 'build-worker' as const }) })
    if (hasRunsc && image.code === 0) {
      const probe = await this.docker.tryExec(['run', '--rm', '--runtime', REQUIRED_RUNTIME, '--network', 'none', this.config.image, 'sh', '-c', 'dmesg 2>/dev/null | head -n 3; id -u'])
      const isolated = probe.code === 0 && /gVisor/i.test(probe.stdout)
      checks.push({ id: 'isolation', ok: isolated, detail: isolated ? 'container kernel is gVisor' : `gVisor probe failed: ${probe.stderr.trim() || probe.stdout.trim()}`, ...(isolated ? {} : { remedy: SETUP_REMEDIES.runtime }) })
      await mkdir(join(this.config.dataDir, 'workspaces'), { recursive: true })
      const reach = await this.docker.tryExec(['run', '--rm', '--runtime', REQUIRED_RUNTIME, '--network', 'none', '--user', `${this.config.uid}:${this.config.gid}`,
        '--mount', `type=bind,source=${join(this.config.dataDir, 'workspaces')},target=/probe,readonly`, this.config.image, 'ls', '/probe'])
      checks.push(reach.code === 0
        ? { id: 'data-dir', ok: true, detail: 'workspace folder is reachable by the container user' }
        : { id: 'data-dir', ok: false, detail: `the container user ${this.config.uid} cannot reach ${this.config.dataDir}`, remedy: SETUP_REMEDIES.dataDir })
      const tools = await this.docker.tryExec(['run', '--rm', '--runtime', REQUIRED_RUNTIME, '--network', 'none', '--user', `${this.config.uid}:${this.config.gid}`, this.config.image,
        'sh', '-c', `command -v git && command -v bash && command -v rg && node --version && test -r ${FS_HELPER}`])
      checks.push(tools.code === 0
        ? { id: 'worker', ok: true, detail: 'worker image has git, bash, ripgrep, Node and the file helper' }
        : { id: 'worker', ok: false, detail: 'worker image lacks git, bash, ripgrep, Node or the file helper', remedy: SETUP_REMEDIES.image(this.config.image), ...(this.config.workerDir === undefined ? {} : { action: 'build-worker' as const }) })
    }
    return { ok: checks.every(c => c.ok), checks }
  }

  /**
   * Build the worker image from the bundled Dockerfile. Runs only on an
   * explicit user action from the setup panel.
   * @param signal - cancels the build.
   * @returns the build log tail.
   */
  async buildWorker(signal?: AbortSignal): Promise<string> {
    const dir = this.config.workerDir
    if (dir === undefined || !existsSync(join(dir, 'Dockerfile'))) throw new WorkspaceError('not-found', 'the worker Dockerfile is not bundled with this installation')
    if (!existsSync(join(dir, 'fs-helper.js'))) throw new WorkspaceError('not-found', 'the worker file helper is missing; rebuild the dsh-code package')
    const args = ['build', '-t', this.config.image, dir]
    const result = await this.docker.tryExec(args, signal)
    // BuildKit reports progress on stderr.
    const log = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-20).join('\n')
    if (result.code !== 0) throw new WorkspaceError('provision-failed', `worker image build failed:\n${log}`)
    return log
  }

  /** Load records from disk and reconcile them against Docker state. */
  async reconcile(): Promise<{ orphansRemoved: string[]; offline: string[] }> {
    await mkdir(this.recordsDir, { recursive: true })
    // A running proxy reloads this file, so a policy saved while Harness was down applies now.
    await this.updatePolicy(this.config.policy)
    await mkdir(join(this.config.dataDir, 'overrides'), { recursive: true, mode: 0o700 })
    for (const file of await readdir(join(this.config.dataDir, 'overrides'))) {
      if (!file.endsWith('.json')) continue
      try {
        this.overrides.set(file.slice(0, -5), JSON.parse(await readFile(join(this.config.dataDir, 'overrides', file), 'utf8')) as Record<string, boolean>)
      } catch {
        // A damaged overrides file is ignored; the session follows Settings.
      }
    }
    // Session variables are read by every exec, which is synchronous; load them before any command runs.
    await mkdir(join(this.config.dataDir, 'env'), { recursive: true, mode: 0o700 })
    for (const file of await readdir(join(this.config.dataDir, 'env'))) {
      if (!file.endsWith('.json')) continue
      try {
        this.sessionEnv.set(file.slice(0, -5), JSON.parse(await readFile(join(this.config.dataDir, 'env', file), 'utf8')) as Record<string, string>)
      } catch {
        // A damaged variables file is ignored; the session starts with the defaults only.
      }
    }
    for (const file of await readdir(this.recordsDir)) {
      if (!file.endsWith('.json')) continue
      const record = JSON.parse(await readFile(join(this.recordsDir, file), 'utf8')) as WorkspaceRecord
      if (record.status !== 'deleted') this.records.set(record.sessionId, record)
    }
    const orphansRemoved: string[] = []
    for (const id of await this.docker.containersWithLabel(`${OWNER_LABEL}=${this.owner}`)) {
      if (id === this.proxyContainer) continue
      const info = await this.docker.inspect(id)
      const sessionId = info?.labels[SESSION_LABEL]
      if (sessionId === undefined) continue
      if (!this.records.has(sessionId)) {
        await this.docker.removeContainer(id)
        orphansRemoved.push(id)
      }
    }
    const offline: string[] = []
    for (const record of this.records.values()) {
      if (record.status === 'deleting') {
        await this.delete(record.sessionId).catch(() => undefined)
        continue
      }
      const info = await this.docker.inspect(record.containerName)
      if (info === undefined || !info.running || info.runtime !== REQUIRED_RUNTIME) {
        await this.setStatus(record, 'offline')
        offline.push(record.sessionId)
      }
    }
    return { orphansRemoved, offline }
  }

  /** Ensure the internal network and the egress proxy are running with the current policy. */
  async ensureNetwork(): Promise<void> {
    await mkdir(join(this.config.dataDir, 'egress'), { recursive: true })
    await cp(this.config.proxyDir, this.proxySourceDir, { recursive: true, force: true })
    await writeFile(this.policyPath, JSON.stringify(this.config.policy), { mode: 0o644 })
    await this.docker.ensureNetwork(this.internalNetwork, ['--internal', '--driver', 'bridge', '--label', `${OWNER_LABEL}=${this.owner}`])
    await this.docker.ensureNetwork(this.egressNetwork, ['--driver', 'bridge', '--label', `${OWNER_LABEL}=${this.owner}`])
    const info = await this.docker.inspect(this.proxyContainer)
    if (info?.running === true) return
    if (info !== undefined) await this.docker.removeContainer(this.proxyContainer)
    await this.docker.exec([
      // The proxy is dsh-code's own trusted code, not workspace code. It runs
      // under the default runtime because it must resolve names through the
      // daemon's resolver, which gVisor's network stack cannot reach.
      'create', '--name', this.proxyContainer,
      '--label', `${OWNER_LABEL}=${this.owner}`, '--user', '65534:65534', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--read-only', '--pids-limit', '256', '--memory', '256m', '--restart', 'unless-stopped',
      '--network', this.egressNetwork,
      '--mount', `type=bind,source=${this.proxySourceDir},target=/opt/egress/src,readonly`,
      '--mount', `type=bind,source=${this.config.dataDir}/egress,target=/opt/egress/policy,readonly`,
      this.config.proxyImage, 'node', `/opt/egress/src/${existsSync(join(this.proxySourceDir, 'entry.js')) ? 'entry.js' : 'entry.ts'}`, '/opt/egress/policy/policy.json', String(PROXY_PORT),
    ])
    await this.docker.exec(['network', 'connect', '--alias', this.proxyContainer, this.internalNetwork, this.proxyContainer])
    await this.docker.exec(['start', this.proxyContainer])
  }

  private async proxyAddress(): Promise<string> {
    const address = await this.docker.exec(['inspect', '--format', `{{(index .NetworkSettings.Networks "${this.internalNetwork}").IPAddress}}`, this.proxyContainer])
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) throw new WorkspaceError('provision-failed', 'egress proxy has no internal address')
    return address
  }

  /**
   * Replace the egress policy; the proxy reloads it and closes refused tunnels.
   * @param policy - the new policy.
   */
  async updatePolicy(policy: EgressPolicy): Promise<void> {
    this.config.policy = policy
    await mkdir(join(this.config.dataDir, 'egress'), { recursive: true })
    await writeFile(this.policyPath, JSON.stringify(policy), { mode: 0o644 })
  }

  /**
   * Replace resource limits. Running containers get the new CPU, memory and
   * process limits in place when the runtime supports it; the `/tmp` size and
   * anything the runtime refuses take effect on the next restart.
   * @param limits - the new limits.
   * @returns session ids whose container kept its old limits until restart.
   */
  async updateLimits(limits: ResourceLimits): Promise<string[]> {
    this.config.limits = limits
    const deferred: string[] = []
    for (const record of this.records.values()) {
      if (record.status !== 'ready') continue
      const result = await this.docker.tryExec(['update', '--cpus', String(limits.cpus), '--memory', `${limits.memoryMb}m`, '--memory-swap', `${limits.memoryMb}m`, '--pids-limit', String(limits.pids), record.containerName])
      if (result.code !== 0) deferred.push(record.sessionId)
    }
    return deferred
  }

  /**
   * Resource usage of one workspace container.
   * @param sessionId - logical session id.
   * @returns usage, or undefined when the container is not running.
   */
  async usage(sessionId: string): Promise<WorkspaceUsage | undefined> {
    const record = this.records.get(sessionId)
    if (record === undefined || record.status !== 'ready') return undefined
    const stats = await this.docker.tryExec(['stats', '--no-stream', '--format', '{{json .}}', record.containerName])
    if (stats.code !== 0) return undefined
    const disk = await this.runInside(record, ['du', '-s', '-B1', record.path]).catch(() => '0')
    return parseStats(stats.stdout, this.config.limits, Number(disk.split(/\s+/)[0]) || 0)
  }

  /**
   * Internal address of a declared preview port, for the authenticated proxy.
   * @param sessionId - logical session id.
   * @param port - container port.
   * @returns host and port on the internal network.
   */
  /**
   * TCP ports a process in the workspace is listening on, read from /proc/net inside the container.
   * @param sessionId - logical session id.
   * @returns listening ports, each marked when it accepts only loopback connections.
   */
  async listeningPorts(sessionId: string): Promise<ListeningPort[]> {
    const record = this.require(sessionId)
    if (record.status !== 'ready') return []
    const text = await this.runInside(record, ['sh', '-c', 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null; true']).catch(() => '')
    return parseListeningPorts(text)
  }

  /**
   * `docker` arguments that open one connection to a port inside the workspace: a small Node relay connects to
   * 127.0.0.1 inside the container and carries the raw TCP bytes over the exec's stdin/stdout. Works on every host
   * (no route from the host into the container is needed) and reaches apps bound to 127.0.0.1 too.
   * @param sessionId - logical session id.
   * @param port - container port.
   * @returns argv after `docker`.
   */
  /**
   * `docker` arguments that run the isolated-browser bridge in the workspace, opening `url` first.
   * @param sessionId - logical session id.
   * @param url - start page, already checked by the caller.
   * @returns argv after `docker`.
   */
  async browserArgv(sessionId: string, url: string): Promise<string[]> {
    const record = this.require(sessionId)
    if (record.status !== 'ready') throw new WorkspaceError('unsafe-state', `workspace is ${record.status}`)
    return this.execArgv(record, ['node', '/opt/dsh-code/browser-bridge.js', url], record.path, {}, false)
  }

  async previewRelayArgv(sessionId: string, port: number): Promise<string[]> {
    // An empty list means no restriction: links are minted only for ports found listening (see previewUrl).
    if (this.config.previewPorts.length > 0 && !this.config.previewPorts.includes(port)) throw new WorkspaceError('unsafe-state', `port ${port} is not in Settings > Code > Preview ports`)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new WorkspaceError('unsafe-state', `invalid port ${port}`)
    const record = this.require(sessionId)
    if (record.status !== 'ready') throw new WorkspaceError('unsafe-state', `workspace is ${record.status}`)
    return this.execArgv(record, ['node', '-e', PREVIEW_RELAY, String(port)], record.path, {}, false)
  }



  /** Load records from disk and reconcile them against Docker state. */

  /**
   * The record for a session, if any.
   * @param sessionId - logical session id.
   * @returns the record.
   */
  get(sessionId: string): WorkspaceRecord | undefined {
    return this.records.get(sessionId)
  }

  /** @returns every live record. */
  list(): WorkspaceRecord[] {
    return [...this.records.values()]
  }

  /**
   * Find the workspace whose checkout contains a path.
   * @param path - absolute host path.
   * @returns the owning record, or undefined.
   */
  owning(path: string): WorkspaceRecord | undefined {
    const target = resolve(path)
    for (const record of this.records.values()) {
      if (target === record.path || target.startsWith(`${record.path}/`)) return record
    }
    return undefined
  }

  /**
   * Provision a workspace for a session (idempotent per session).
   * @param sessionId - logical session id.
   * @param repository - repository to clone.
   * @param baseBranch - base branch.
   * @param onProgress - progress callback for the UI.
   * @returns the ready record.
   */
  provision(sessionId: string, repository: RepositoryRef, baseBranch: string, onProgress: (step: string, detail?: string) => void = () => {}, account: string = ''): Promise<WorkspaceRecord> {
    const existing = this.records.get(sessionId)
    if (existing !== undefined && existing.status === 'ready') return Promise.resolve(existing)
    const inflight = this.pending.get(sessionId)
    if (inflight !== undefined) return inflight
    const attempt = this.doProvision(sessionId, repository, baseBranch, onProgress, account).finally(() => { this.pending.delete(sessionId) })
    this.pending.set(sessionId, attempt)
    return attempt
  }

  /**
   * The options a new container gets now: Lockdown forces a read-only checkout, no cache and no extra folders.
   * Folders that are unsafe, missing, not directories or inside dataDir are skipped and reported, never fatal.
   */
  private async optionsFor(repository: RepositoryRef, onProgress: (step: string, detail?: string) => void): Promise<WorkspaceOptions> {
    const lockdown = this.config.lockdown === true
    const folders: string[] = []
    for (const folder of lockdown ? [] : this.config.readOnlyFolders ?? []) {
      const dataDir = resolve(this.config.dataDir)
      const reason = unsafeFolderReason(folder)
        ?? (folder === dataDir || folder.startsWith(`${dataDir}/`) || dataDir.startsWith(`${folder}/`) ? 'it overlaps the Code data folder' : undefined)
        ?? (existsSync(folder) && statSync(folder).isDirectory() ? undefined : 'it does not exist or is not a folder')
      if (reason === undefined) folders.push(folder)
      else onProgress('folder-skipped', `${folder}: ${reason}`)
    }
    let cacheDir: string | undefined
    if (!lockdown && this.config.dependencyCache === true) {
      // One cache per repository: a repository can never plant packages in another one's cache.
      cacheDir = join(this.config.dataDir, 'caches', repository.fullName.replace(/[^A-Za-z0-9._-]+/g, '__'))
      await mkdir(cacheDir, { recursive: true, mode: 0o700 })
      if (process.getuid?.() === 0) await chown(cacheDir, this.config.uid, this.config.gid)
    }
    return {
      readOnlyWorkspace: lockdown || this.config.readOnlyWorkspace === true, readOnlyFolders: folders,
      shmMb: this.config.shmMb ?? 256, lockdown, ...cacheDir === undefined ? {} : { cacheDir },
    }
  }

  private readonly sessionEnv = new Map<string, Record<string, string>>()
  private readonly overrides = new Map<string, Record<string, boolean>>()
  private overridesPath(sessionId: string): string { return join(this.config.dataDir, 'overrides', `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`) }

  /**
   * A session's overrides of Settings > Code (absent fields follow Settings).
   * @param sessionId - logical session id.
   * @returns the saved overrides.
   */
  sessionOverrides(sessionId: string): Readonly<Record<string, boolean>> {
    return this.overrides.get(sessionId) ?? {}
  }

  /**
   * Replace a session's overrides; saved under dataDir/overrides.
   * @param sessionId - logical session id.
   * @param values - boolean overrides by name.
   */
  async setSessionOverrides(sessionId: string, values: Readonly<Record<string, boolean>>): Promise<void> {
    await mkdir(join(this.config.dataDir, 'overrides'), { recursive: true, mode: 0o700 })
    await writeFile(this.overridesPath(sessionId), JSON.stringify(values), { mode: 0o600 })
    this.overrides.set(sessionId, { ...values })
  }
  private envPath(sessionId: string): string { return join(this.config.dataDir, 'env', `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`) }

  /**
   * A session's own variables, saved under dataDir/env.
   * @param sessionId - logical session id.
   * @returns the session's variables (without the defaults).
   */
  async sessionEnvironment(sessionId: string): Promise<Record<string, string>> {
    const known = this.sessionEnv.get(sessionId)
    if (known !== undefined) return known
    let loaded: Record<string, string> = {}
    try {
      loaded = JSON.parse(await readFile(this.envPath(sessionId), 'utf8')) as Record<string, string>
    } catch {
      // No variables saved for this session.
    }
    this.sessionEnv.set(sessionId, loaded)
    return loaded
  }

  /**
   * Replace a session's own variables; the next command in its workspace sees them.
   * @param sessionId - logical session id.
   * @param env - already validated variables.
   */
  async setSessionEnvironment(sessionId: string, env: Readonly<Record<string, string>>): Promise<void> {
    await mkdir(join(this.config.dataDir, 'env'), { recursive: true, mode: 0o700 })
    await writeFile(this.envPath(sessionId), JSON.stringify(env), { mode: 0o600 })
    this.sessionEnv.set(sessionId, { ...env })
  }

  /**
   * Variables a command in this session starts with: the defaults, then the session's own values.
   * @param sessionId - logical session id.
   * @returns merged variables.
   */
  environmentFor(sessionId: string): Record<string, string> {
    return { ...this.config.environment, ...this.sessionEnv.get(sessionId) }
  }

  private async gitAs(account: string | undefined): Promise<Git> {
    return account === undefined || account === '' ? this.git : this.git.withEnv(await this.credentials(account))
  }

  private async doProvision(sessionId: string, repository: RepositoryRef, baseBranch: string, onProgress: (step: string, detail?: string) => void, account: string): Promise<WorkspaceRecord> {
    const live = [...this.records.values()].filter(r => r.status !== 'deleted' && r.sessionId !== sessionId).length
    if (live >= this.config.maxWorkspaces) throw new WorkspaceError('limit-reached', `at most ${this.config.maxWorkspaces} Code workspaces may run on this host`)
    onProgress('checking-runtime')
    const runtimes = await this.docker.runtimes()
    if (!runtimes.includes(REQUIRED_RUNTIME)) throw new WorkspaceError('gvisor-unavailable', 'Docker has no runsc runtime; Code execution is blocked')
    onProgress('egress-proxy')
    await this.ensureNetwork()
    const workspaceId = this.records.get(sessionId)?.workspaceId ?? randomUUID()
    const path = join(this.config.dataDir, 'workspaces', workspaceId)
    const mirrorPath = join(this.config.dataDir, 'mirrors', `${workspaceId}.git`)
    const now = new Date().toISOString()
    const prior = this.records.get(sessionId)
    let record: WorkspaceRecord
    if (prior === undefined) {
      onProgress('resolving-revision')
      const workingBranch = this.config.newBranch === false ? baseBranch : workingBranchName()
      await mkdir(join(this.config.dataDir, 'workspaces'), { recursive: true })
      await mkdir(join(this.config.dataDir, 'mirrors'), { recursive: true })
      onProgress('cloning')
      const git = await this.gitAs(account)
      const checkout = await git.prepareCheckout(repository, baseBranch, path, workingBranch)
      await git.createMirror(repository, mirrorPath)
      await chownTree(path, this.config.uid, this.config.gid)
      record = {
        workspaceId, sessionId, repository, ...account === '' ? {} : { account }, baseBranch, baseCommit: checkout.baseCommit, workingBranch,
        path, mirrorPath, containerName: `${this.namespace}-${workspaceId.slice(0, 12)}`, image: this.config.image,
        runtime: REQUIRED_RUNTIME, status: 'provisioning', createdAt: now, updatedAt: now,
      }
      await this.save(record)
    } else {
      record = prior
      await this.setStatus(record, 'restarting')
    }
    try {
      onProgress('starting-container')
      await this.docker.removeContainer(record.containerName)
      const proxyAddress = await this.proxyAddress()
      const options = await this.optionsFor(record.repository, onProgress)
      record.options = options
      await this.save(record)
      await this.docker.exec(createArgs({
        readOnlyWorkspace: options.readOnlyWorkspace, readOnlyFolders: options.readOnlyFolders, shmMb: options.shmMb,
        ...options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir },
        name: record.containerName, owner: this.owner, image: record.image, sessionId, workspaceId,
        workspacePath: record.path, network: this.internalNetwork,
        proxyUrl: this.config.policy.mode === 'none' ? undefined : `http://${this.proxyContainer}:${PROXY_PORT}`,
        uid: this.config.uid, gid: this.config.gid, limits: this.config.limits,
        hosts: { [this.proxyContainer]: proxyAddress },
      }))
      await this.docker.exec(['start', record.containerName])
      onProgress('health-check')
      const info = await this.docker.inspect(record.containerName)
      if (info?.runtime !== REQUIRED_RUNTIME) throw new WorkspaceError('unsafe-state', 'container is not running under runsc')
      await this.docker.exec(['exec', record.containerName, 'true'])
      await this.setStatus(record, 'ready')
      return record
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error)
      await this.setStatus(record, 'failed')
      throw error instanceof WorkspaceError ? error : new WorkspaceError('provision-failed', record.error)
    }
  }

  /**
   * Restart the worker container while keeping the checkout.
   * @param sessionId - logical session id.
   * @returns the ready record.
   */
  restart(sessionId: string, onProgress?: (step: string) => void): Promise<WorkspaceRecord> {
    const record = this.records.get(sessionId)
    if (record === undefined) return Promise.reject(new WorkspaceError('not-found', `no workspace for session ${sessionId}`))
    return this.provision(sessionId, record.repository, record.baseBranch, onProgress, record.account)
  }

  /**
   * Build `docker exec` argv for a process inside the session container.
   * @param record - workspace.
   * @param argv - program.
   * @param cwd - absolute path inside the checkout.
   * @param env - environment.
   * @param tty - allocate a terminal.
   * @returns argv after `docker`.
   */
  execArgv(record: WorkspaceRecord, argv: readonly string[], cwd: string, env: Readonly<Record<string, string>>, tty: boolean): string[] {
    if (record.status !== 'ready') throw new WorkspaceError('unsafe-state', `workspace is ${record.status}`)
    const target = resolve(cwd)
    if (target !== record.path && !target.startsWith(`${record.path}/`)) throw new WorkspaceError('unsafe-state', `cwd outside the session workspace: ${cwd}`)
    return execArgs(record.containerName, argv, target, env, tty)
  }

  /**
   * Run a command inside the container and capture output (for Git status/diff).
   * @param record - workspace.
   * @param argv - program.
   * @returns stdout.
   */
  async runInside(record: WorkspaceRecord, argv: readonly string[]): Promise<string> {
    return this.docker.exec(this.execArgv(record, argv, record.path, {}, false))
  }

  /**
   * Uncommitted and unpushed work, computed inside the sandbox.
   * @param sessionId - logical session id.
   * @returns counts, or undefined when the container is unavailable.
   */
  async pendingWork(sessionId: string): Promise<{ dirtyFiles: number; unpushedCommits: number } | undefined> {
    const record = this.records.get(sessionId)
    if (record === undefined || record.status !== 'ready') return undefined
    const status = await this.runInside(record, ['git', 'status', '--porcelain=v1'])
    const ahead = await this.runInside(record, ['git', 'rev-list', '--count', 'HEAD', '--not', '--remotes']).catch(() => '0')
    return { dirtyFiles: status === '' ? 0 : status.split('\n').length, unpushedCommits: Number(ahead) || 0 }
  }

  /**
   * Diff of the checkout against the pinned base, computed inside the sandbox.
   * @param sessionId - logical session id.
   * @returns unified diff.
   */
  async diff(sessionId: string): Promise<string> {
    const record = this.require(sessionId)
    await this.runInside(record, ['git', 'add', '--intent-to-add', '--all'])
    return this.runInside(record, ['git', 'diff', record.baseCommit, '--'])
  }

  /**
   * Commit all changes inside the sandbox and push the working branch from the host mirror.
   * @param sessionId - logical session id.
   * @param message - commit message.
   * @returns the pushed SHA.
   */
  async commitAndPush(sessionId: string, message: string): Promise<{ sha: string; branch: string }> {
    const record = this.require(sessionId)
    await this.runInside(record, ['git', 'add', '--all'])
    const staged = await this.runInside(record, ['git', 'diff', '--cached', '--name-only'])
    if (staged !== '') {
      await this.runInside(record, ['git', '-c', 'user.name=DeepSeek Harness Code', '-c', 'user.email=dsh-code@users.noreply.github.com', 'commit', '-q', '-m', message])
    }
    const outbox = join(record.path, '.git', 'dsh-code-outbox.bundle')
    await this.runInside(record, ['git', 'bundle', 'create', '-q', outbox, `refs/heads/${record.workingBranch}`])
    const copy = `${record.mirrorPath}.bundle`
    await copyRegularFile(outbox, copy)
    try {
      const sha = await (await this.gitAs(record.account)).pushFromBundle(record.mirrorPath, copy, record.workingBranch)
      return { sha, branch: record.workingBranch }
    } finally {
      await rm(copy, { force: true })
    }
  }

  /**
   * Delete the container, the checkout, the mirror and the record. Remote
   * branches and pull requests are left untouched.
   * @param sessionId - logical session id.
   */
  async delete(sessionId: string): Promise<void> {
    this.sessionEnv.delete(sessionId)
    await rm(this.envPath(sessionId), { force: true })
    this.overrides.delete(sessionId)
    await rm(this.overridesPath(sessionId), { force: true })
    const record = this.records.get(sessionId)
    if (record === undefined) return
    await this.setStatus(record, 'deleting')
    await this.docker.removeContainer(record.containerName)
    await rm(record.path, { recursive: true, force: true })
    await rm(record.mirrorPath, { recursive: true, force: true })
    await this.setStatus(record, 'deleted')
    this.records.delete(sessionId)
    await rm(join(this.recordsDir, `${record.workspaceId}.json`), { force: true })
  }

  private require(sessionId: string): WorkspaceRecord {
    const record = this.records.get(sessionId)
    if (record === undefined) throw new WorkspaceError('not-found', `no workspace for session ${sessionId}`)
    return record
  }

  private async setStatus(record: WorkspaceRecord, status: WorkspaceStatus): Promise<void> {
    record.status = status
    record.updatedAt = new Date().toISOString()
    await this.save(record)
  }

  private async save(record: WorkspaceRecord): Promise<void> {
    this.records.set(record.sessionId, record)
    await mkdir(this.recordsDir, { recursive: true })
    await writeFile(join(this.recordsDir, `${record.workspaceId}.json`), JSON.stringify(record, null, 2))
  }
}

/** Path of the file helper in the worker image. */
const FS_HELPER = '/opt/dsh-code/fs-helper.js'

/** User-facing fixes for failing setup checks. */
export const SETUP_REMEDIES = {
  docker: 'Install Docker Engine (https://docs.docker.com/engine/install/) and start it, then make sure the user running Harness may use it.',
  runtime: 'Install gVisor (https://gvisor.dev/docs/user_guide/install/), register it with `sudo runsc install`, then `sudo systemctl reload docker`. Code never falls back to ordinary Docker.',
  image: (image: string): string => `Build the worker image: \`docker build -t ${image} <package>/worker\` after \`pnpm run build\`, or use Build worker image.`,
  dataDir: 'Choose a data folder the container user can traverse, outside a private home directory (Settings > Code needs a restart for this one, or set dataDir in cordis.patch.yml).',
} as const

const UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 }

/**
 * Parse a Docker size such as `12.5MiB`.
 * @param text - size text.
 * @returns bytes.
 */
export function parseSize(text: string): number {
  const match = /^\s*([\d.]+)\s*([a-zA-Z]*)\s*$/.exec(text)
  if (match === null) return 0
  return Math.round(Number(match[1]) * (UNITS[(match[2] ?? 'b').toLowerCase() || 'b'] ?? 1))
}

/**
 * Parse one `docker stats --format '{{json .}}'` line.
 * @param line - JSON line.
 * @param limits - configured limits, for the process limit.
 * @param diskBytes - checkout size.
 * @returns usage.
 */
export function parseStats(line: string, limits: ResourceLimits, diskBytes: number): WorkspaceUsage {
  const raw = JSON.parse(line.trim().split('\n')[0] ?? '{}') as { CPUPerc?: string; MemUsage?: string; PIDs?: string }
  const [used, limit] = (raw.MemUsage ?? '0B / 0B').split('/')
  return {
    cpuPercent: Number.parseFloat(raw.CPUPerc ?? '0') || 0,
    memoryBytes: parseSize(used ?? '0'),
    memoryLimitBytes: parseSize(limit ?? '0') || limits.memoryMb * 1024 * 1024,
    pids: Number.parseInt(raw.PIDs ?? '0', 10) || 0,
    pidsLimit: limits.pids,
    diskBytes,
  }
}

/** Copy a file out of a sandbox-writable tree, refusing symlinks and special files. */
async function copyRegularFile(source: string, destination: string): Promise<void> {
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!(await handle.stat()).isFile()) throw new WorkspaceError('unsafe-state', 'sandbox output is not a regular file')
    await writeFile(destination, await handle.readFile(), { mode: 0o600 })
  } finally {
    await handle.close()
  }
}

/**
 * Give a fresh checkout to the sandbox user when Harness runs as root; a no-op otherwise.
 * Exported for the root-only regression test.
 * @param path - checkout root.
 * @param uid - sandbox uid.
 * @param gid - sandbox gid.
 */
export async function chownTree(path: string, uid: number, gid: number): Promise<void> {
  if (process.getuid?.() !== 0) return
  await chown(path, uid, gid)
  for (const entry of await readdir(path, { withFileTypes: true, recursive: true })) {
    // A cloned repository can contain symlinks to host files; chown would follow them and hand
    // those files to the sandbox user. lchown changes the link itself.
    const target = join(entry.parentPath, entry.name)
    await (entry.isSymbolicLink() ? lchown(target, uid, gid) : chown(target, uid, gid)).catch(() => undefined)
  }
}
