/**
 * Host service `codeWorkspaces`: owns the {@link WorkspaceManager}, exposes
 * the Remote API the Code UI calls (setup status, repositories, branches,
 * session selection, diff, commit, pull request, restart, delete), holds a
 * Code session's first message until its gVisor workspace is ready and its
 * working directory points into the checkout, and deletes the workspace when
 * the session is archived. Mount it on the host plane, outside presets.
 */
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, realpathSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-workspace'
import { WorkspaceError, WorkspaceManager, type WorkspaceManagerConfig, type WorkspaceRecord } from '../core/workspaces.ts'
import { EnvironmentError, environmentLines, parseEnvironment } from '../core/environment.ts'
import { GitHubProvider, SourceControlError } from '../core/github.ts'
import type { AccountRepositories, BranchList, GhAccount, PreviewTargets, ProvisionStep, SessionVariables, CodeSessionView, CodeSettings, CodeSettingsView, PendingWork, PushResult, RepositorySummary, SelfTestReport, SessionEnvironment, WorkspaceUsage } from '../types.ts'
import { onlySettingsChanged, SETTINGS_FIELDS, SettingsError, validateSettings } from '../core/settings.ts'
import { PREVIEW_PREFIX, PreviewProxy } from './preview.ts'
import { Git, gitRunner } from '../core/git.ts'
import { DEFAULT_ALLOW, type EgressMode } from '../egress/policy.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Declared by `@deepseek-ai/dsh-workspace` from 0.2.2-rc.2; restated so
     * this package builds against the published 0.2.2-rc.1 declarations.
     * @param request - the archived Session.
     * @mode parallel
     */
    'workspace/session-archived'(request: { readonly sessionId: SessionId }): Promise<void> | void
  }
  interface Context {
    /** Code workspace lifecycle and the Code UI's Remote API. */
    codeWorkspaces: CodeWorkspacesService
  }
}

/** Deployment configuration (Settings > Code). */
export interface Config {
  dataDir: string
  workerImage: string
  proxyImage: string
  cpus: number
  memoryMb: number
  pids: number
  tmpMb: number
  maxWorkspaces: number
  uid: number
  gid: number
  network: EgressMode
  allow: string[]
  privateAllow: string[]
  ports: number[]
  previewPorts: number[]
  presetId: string
  defaultAccount: string
  disabledAccounts: string[]
  newBranch: boolean
  shmMb: number
  readOnlyWorkspace: boolean
  dependencyCache: boolean
  readOnlyFolders: string[]
  environment: string[]
  lockdown: boolean
}

export const Config: z<Config> = z.object({
  // A root host keeps data outside /root, which the non-root container user cannot traverse.
  dataDir: z.string().default(process.getuid?.() === 0 ? '/var/lib/dsh-code' : join(homedir(), '.dsh-code')).description('Workspaces, mirrors and records'),
  workerImage: z.string().default('dsh-code-worker:0.2.0').description('Worker image; pin by digest in production'),
  proxyImage: z.string().default('node:24-alpine').description('Image that runs the egress proxy'),
  cpus: z.number().default(2),
  memoryMb: z.number().default(4096),
  pids: z.number().default(512),
  tmpMb: z.number().default(1024),
  maxWorkspaces: z.number().default(8),
  uid: z.number().default(process.getuid?.() === 0 || process.getuid === undefined ? 1000 : process.getuid()),
  gid: z.number().default(process.getgid?.() === 0 || process.getgid === undefined ? 1000 : process.getgid()),
  network: z.union(['allowlist', 'none', 'open'] as const).default('allowlist'),
  allow: z.array(z.string()).default([...DEFAULT_ALLOW]),
  privateAllow: z.array(z.string()).default([]),
  ports: z.array(z.number()).default([80, 443]),
  previewPorts: z.array(z.number()).default([]).description('Container ports that may be opened as authenticated previews'),
  presetId: z.string().default('code'),
  disabledAccounts: z.array(z.string()).default([]).description('gh logins left out of the Repository menu'),
  shmMb: z.number().default(256).description('/dev/shm size in MB; headless browsers need more than 64'),
  readOnlyWorkspace: z.boolean().default(false).description('Mount checkouts read-only'),
  dependencyCache: z.boolean().default(false).description('Keep a dependency cache per repository'),
  readOnlyFolders: z.array(z.string()).default([]).description('Extra host folders mounted read-only at the same path'),
  environment: z.array(z.string()).default([]).description('Default NAME=value variables for every Code session'),
  lockdown: z.boolean().default(false).description('Network none, read-only workspace, no cache and no extra folders'),
  newBranch: z.boolean().default(true).description('Give each Code session its own dsh-code/<hash> branch; false works on the chosen branch'),
  defaultAccount: z.string().default('').description('GitHub account (gh login) new Code sessions use; empty uses the gh CLI active account'),
})

interface Selection {
  readonly repository: RepositorySummary
  readonly baseBranch: string
  readonly account: string
}

function view(sessionId: string, record: WorkspaceRecord | undefined, selection: Selection | undefined): CodeSessionView | undefined {
  if (record !== undefined) {
    return {
      sessionId, account: record.account ?? '', repository: record.repository.fullName, baseBranch: record.baseBranch, baseCommit: record.baseCommit,
      workingBranch: record.workingBranch, status: record.status, ...(record.error === undefined ? {} : { error: record.error }),
    }
  }
  if (selection !== undefined) return { sessionId, account: selection.account, repository: selection.repository.fullName, baseBranch: selection.baseBranch, status: 'pending' }
  return undefined
}

function remoteFailure(error: unknown): RemoteError<'code/failed'> {
  if (error instanceof SourceControlError) return new RemoteError('code/failed', error.message, { reason: error.code === 'auth' ? 'source-control-auth' : 'source-control' })
  if (error instanceof WorkspaceError) return new RemoteError('code/failed', error.message, { reason: error.code })
  if (error instanceof SettingsError) return new RemoteError('code/failed', error.message, { reason: 'invalid-settings' })
  return new RemoteError('code/failed', error instanceof Error ? error.message : String(error), { reason: 'failed' })
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A Code operation failed; `reason` names the recovery path. */
    'code/failed': { readonly reason: string }
  }
}

/** The part of `ctx.configEditor` (`@deepseek-ai/dsh-config-editor`) this service uses. */
interface ConfigEditorFace {
  edit(entry: unknown, change: (current: Record<string, unknown>) => Record<string, unknown>): Promise<void>
}

/** The part of `ctx.webServer` (`@deepseek-ai/dsh-webserver`) this service uses. */
interface WebServerFace {
  register(route: { kind: 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }): () => void
}

function settingsOf(config: Config): CodeSettings {
  return {
    network: config.network, allow: config.allow, privateAllow: config.privateAllow, ports: config.ports,
    cpus: config.cpus, memoryMb: config.memoryMb, pids: config.pids, tmpMb: config.tmpMb, maxWorkspaces: config.maxWorkspaces,
    workerImage: config.workerImage, previewPorts: config.previewPorts,
    disabledAccounts: config.disabledAccounts, newBranch: config.newBranch,
    shmMb: config.shmMb, readOnlyWorkspace: config.readOnlyWorkspace, dependencyCache: config.dependencyCache,
    readOnlyFolders: config.readOnlyFolders, environment: config.environment, lockdown: config.lockdown,
  }
}

/** Manager options derived from the row config; Lockdown is applied by the manager and the policy. */
function sandboxOptions(config: Config): Pick<WorkspaceManagerConfig, 'shmMb' | 'readOnlyWorkspace' | 'dependencyCache' | 'readOnlyFolders' | 'lockdown' | 'environment'> {
  let environment: Record<string, string> = {}
  try {
    environment = parseEnvironment(config.environment)
  } catch {
    // An invalid hand-edited list is refused by Settings; at load it is ignored rather than blocking Code.
  }
  return {
    shmMb: config.shmMb, readOnlyWorkspace: config.readOnlyWorkspace, dependencyCache: config.dependencyCache,
    readOnlyFolders: config.readOnlyFolders, lockdown: config.lockdown, environment,
  }
}

/** Code workspace service. */
export class CodeWorkspacesService extends TypertRemoteService {
  static inject = ['workingDirectory']
  static Config = Config

  /** Workspace lifecycle owner; the Code preset's providers read it. */
  readonly manager: WorkspaceManager
  private readonly github = new GitHubProvider()
  private readonly selections = new Map<string, Selection>()
  /** Steps of each session's latest provisioning, also saved under dataDir/steps for the Environment tab. */
  private readonly steps = new Map<string, ProvisionStep[]>()
  private selfTestReport: Promise<SelfTestReport> | undefined

  private readonly previews: PreviewProxy

  /**
   * @param owner - host context of the `code-workspaces` row.
   * @param config - validated configuration.
   */
  constructor(private readonly owner: Context, public config: Config) {
    super(owner, 'codeWorkspaces')
    const ctx = owner
    // Canonical, so the checkout path is the same string on the host and in the container.
    mkdirSync(config.dataDir, { recursive: true })
    const dataDir = realpathSync(config.dataDir)
    this.manager = new WorkspaceManager({
      dataDir, image: config.workerImage, proxyImage: config.proxyImage,
      proxyDir: join(import.meta.dirname, '..', 'egress'),
      workerDir: join(import.meta.dirname, '..', '..', 'worker'),
      limits: { cpus: config.cpus, memoryMb: config.memoryMb, pids: config.pids, tmpMb: config.tmpMb },
      policy: { mode: config.lockdown ? 'none' : config.network, allow: config.allow, privateAllow: config.privateAllow, ports: config.ports },
      uid: config.uid, gid: config.gid, maxWorkspaces: config.maxWorkspaces, previewPorts: config.previewPorts, newBranch: config.newBranch,
      ...sandboxOptions(config),
    }, undefined, new Git(gitRunner('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'])),
    async account => this.github.credentials(account))
    this.previews = new PreviewProxy((sessionId, port) => this.manager.previewAddress(sessionId, port))
    // Settings > Code changes apply in place; anything else restarts the plugin as usual.
    ctx.on('internal/update', (next: Config, restart) => {
      if (!onlySettingsChanged(this.config, next)) return restart()
      return this.apply(next)
    })
    ctx.inject(['webServer'], (scoped) => {
      const server = scoped.get('webServer' as never) as WebServerFace | undefined
      if (server === undefined) return
      scoped.effect(() => server.register({ kind: 'prefix', path: PREVIEW_PREFIX, handler: (req, res) => this.previews.handle(req, res) }), 'dsh-code: preview route')
    })
    ctx.effect(() => {
      const lifetime = new AbortController()
      void this.manager.reconcile().catch((error: unknown) => { ctx.logger('dsh-code').warn('reconcile failed: %s', String(error)) })
      return () => { lifetime.abort() }
    }, 'dsh-code: reconcile workspaces')
    // The Harness hides a preset that fails to load from the mode selector without telling anyone (a row that
    // registers a Host-wide service again is enough). Say so loudly in the dsh output; never block startup.
    ctx.inject(['agentPresets'], (scoped) => scoped.effect(() => {
      const timer = setTimeout(() => {
        const presets = scoped.get('agentPresets' as never) as { resolve(id: string): Promise<{ readonly broken?: string }> } | undefined
        void presets?.resolve(config.presetId).then((preset) => {
          if (preset.broken === undefined) return
          const message = `dsh-code: the "${config.presetId}" preset failed to load, so Code mode is missing from the mode selector:\n${preset.broken}`
          ctx.logger('dsh-code').warn(message)
          console.error(message)
        }).catch((error: unknown) => { ctx.logger('dsh-code').debug('preset check failed: %s', String(error)) })
      }, 5000)
      return () => { clearTimeout(timer) }
    }, 'dsh-code: report a broken Code preset'))
    ctx.effect(() => ctx.on('agent/inbox/inserted', ({ agent }) => { this.hold(agent) }), 'dsh-code: hold first message until provisioned')
    // The mode selector is how a session becomes a Code session; the agent-preset registry re-emits each committed choice.
    const presetEvents = ctx as unknown as { on(name: 'agent-preset/selected', listener: (sessionId: string, agentPreset: string) => void): () => void }
    // Leaving Code mode before the first message drops the session's unprovisioned choices.
    ctx.effect(() => presetEvents.on('agent-preset/selected', (sessionId, agentPreset) => {
      if (agentPreset === config.presetId || this.manager.get(String(sessionId)) !== undefined) return
      this.selections.delete(String(sessionId))
    }), 'dsh-code: leaving Code mode clears choices')
    ctx.effect(() => ctx.on('workspace/session-archived', ({ sessionId }) => {
      this.previews.revoke(sessionId)
      void this.manager.delete(sessionId).catch((error: unknown) => { ctx.logger('dsh-code').warn('cleanup of %s failed: %s', sessionId, String(error)) })
    }), 'dsh-code: delete workspace on archive')
    // A session deleted outright (the session-delete plugin, or anything else) must not leave its container, checkout
    // and mirror behind: clean up on the removal event once the session is really gone, and sweep at startup and every
    // few minutes for removals this plugin never heard about (deleted while Harness was down, or by another plugin).
    const removals = ctx as unknown as { on(name: 'api-session/removed', listener: (sessionId: string) => void): () => void }
    ctx.effect(() => removals.on('api-session/removed', (sessionId) => { void this.collect([String(sessionId)]) }), 'dsh-code: delete workspace of a deleted session')
    ctx.effect(() => {
      const first = setTimeout(() => { void this.collect() }, 30_000)
      const every = setInterval(() => { void this.collect() }, 5 * 60_000)
      return () => { clearTimeout(first); clearInterval(every) }
    }, 'dsh-code: sweep workspaces of deleted sessions')
  }

  /**
   * Whether a session no longer exists anywhere: not live, and the session store clearly reports no such session.
   * Any doubt (no store, a failed lookup) keeps the workspace.
   */
  private async sessionGone(sessionId: string): Promise<boolean> {
    const live = (name: string): boolean => {
      try { return (this.ctx.get(name as never) as { get?(id: string): unknown } | undefined)?.get?.(sessionId) !== undefined } catch { return true }
    }
    if (live('agents') || live('sessions')) return false
    const store = this.ctx.get('sessionPersistence' as never) as { stat?(id: string): Promise<unknown> } | undefined
    if (store?.stat === undefined) return false
    try {
      return await store.stat(sessionId) === undefined
    } catch {
      // The store could not answer; keep the workspace and try again on the next sweep.
      return false
    }
  }

  /**
   * Delete the workspaces of sessions that no longer exist.
   * @param candidates - session ids to check; all recorded workspaces when omitted.
   */
  private async collect(candidates?: readonly string[]): Promise<void> {
    const ids = candidates ?? this.manager.list().map(r => r.sessionId)
    for (const sessionId of ids) {
      if (this.manager.get(sessionId) === undefined && !this.steps.has(sessionId)) continue
      if (!(await this.sessionGone(sessionId))) continue
      this.previews.revoke(sessionId)
      this.selections.delete(sessionId)
      this.steps.delete(sessionId)
      await rm(this.stepsPath(sessionId), { force: true }).catch(() => undefined)
      await this.manager.delete(sessionId).catch((error: unknown) => { this.ctx.logger('dsh-code').warn('cleanup of deleted session %s failed: %s', sessionId, String(error)) })
      this.ctx.logger('dsh-code').info('removed the workspace of deleted session %s', sessionId)
    }
  }

  private hold(agent: Agent): void {
    const sessionId = String(agent.id)
    const record = this.manager.get(sessionId)
    const selection = this.selections.get(sessionId)
    const needsWork = selection !== undefined && record === undefined
      || record !== undefined && (record.status === 'offline' || record.status === 'failed')
    if (!needsWork) return
    const step = (name: string, error?: string): void => { this.recordStep(sessionId, name, error) }
    try {
      void agent.runMaintenance(async (signal) => {
        this.steps.set(sessionId, [])
        step('held')
        await Promise.resolve()
        if (signal.aborted) return
        const ready = record === undefined
          ? await this.manager.provision(sessionId, selection!.repository, selection!.baseBranch, name => { step(name) }, selection!.account)
          : await this.manager.restart(sessionId, name => { step(name) })
        step('working-directory')
        await this.ctx.workingDirectory.set(agent, ready.path, signal)
        this.selections.delete(sessionId)
        step('ready')
      }).catch((error: unknown) => {
        step('failed', error instanceof Error ? error.message : String(error))
        this.ctx.logger('dsh-code').warn('provisioning %s failed: %s', sessionId, String(error))
      })
    } catch (error) {
      // A turn or maintenance already owns the Agent; the message proceeds and
      // the preset's providers refuse to run outside a ready workspace.
      this.ctx.logger('dsh-code').debug('hold skipped for %s: %s', sessionId, String(error))
    }
  }

  private stepsPath(sessionId: string): string {
    return join(this.config.dataDir, 'steps', `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
  }

  private recordStep(sessionId: string, name: string, error?: string): void {
    const list = this.steps.get(sessionId) ?? []
    list.push({ step: name, time: Date.now(), ...error === undefined ? {} : { error } })
    this.steps.set(sessionId, list)
    const path = this.stepsPath(sessionId)
    void mkdir(join(this.config.dataDir, 'steps'), { recursive: true })
      .then(() => writeFile(path, JSON.stringify(list), { mode: 0o600 }))
      .catch((failure: unknown) => { this.ctx.logger('dsh-code').debug('saving steps of %s failed: %s', sessionId, String(failure)) })
  }

  private async stepsOf(sessionId: string): Promise<ProvisionStep[] | undefined> {
    const live = this.steps.get(sessionId)
    if (live !== undefined) return live
    try {
      return JSON.parse(await readFile(this.stepsPath(sessionId), 'utf8')) as ProvisionStep[]
    } catch {
      // No provisioning recorded for this session yet.
      return undefined
    }
  }

  /** The account a session uses: its record, its selection, then the configured default. */
  private accountOf(sessionId: string | null): string {
    if (sessionId === null) return this.config.defaultAccount
    return this.manager.get(sessionId)?.account ?? this.selections.get(sessionId)?.account ?? this.config.defaultAccount
  }

  private async githubAs(account: string): Promise<GitHubProvider> {
    return account === '' ? this.github : this.github.withEnv(await this.github.credentials(account))
  }

  /**
   * Where a session runs, for the Environment tab.
   * @param sessionId - session id.
   * @returns the session's environment.
   */
  @Remote
  async environment(sessionId: string): Promise<SessionEnvironment> {
    const agents = this.ctx.get('agents') as { get(id: string): Agent | undefined } | undefined
    const agent = agents?.get(sessionId)
    const workingDirectory = agent === undefined ? undefined : this.ctx.workingDirectory.get(agent.session)
    const record = this.manager.get(sessionId)
    const selection = this.selections.get(sessionId)
    if (record === undefined && selection === undefined && !(await this.isCodeMode(sessionId))) {
      return { mode: 'host', ...workingDirectory === undefined ? {} : { workingDirectory } }
    }
    const account = this.accountOf(sessionId)
    const login = account !== '' ? account : (await this.github.accounts().catch(() => [])).find(a => a.active)?.login
    const steps = await this.stepsOf(sessionId)
    const applied = record?.options
    const lockdown = applied?.lockdown ?? this.config.lockdown
    const options = applied !== undefined
      ? { readOnlyWorkspace: applied.readOnlyWorkspace, dependencyCache: applied.cacheDir !== undefined, readOnlyFolders: applied.readOnlyFolders, shmMb: applied.shmMb, lockdown }
      : {
        readOnlyWorkspace: lockdown || this.config.readOnlyWorkspace, dependencyCache: !lockdown && this.config.dependencyCache,
        readOnlyFolders: lockdown ? [] : this.config.readOnlyFolders, shmMb: this.config.shmMb, lockdown,
      }
    // The host's folder layout, container name, runtime and image stay on the host: the tab shows what the
    // session works on and how it is fenced, not where things live.
    return {
      mode: 'code',
      options,
      network: lockdown ? 'none' : this.config.network,
      ...steps === undefined ? {} : { steps },
      ...login === undefined ? {} : { account: login },
      ...record !== undefined
        ? {
          repository: record.repository.fullName, baseBranch: record.baseBranch, baseCommit: record.baseCommit,
          workingBranch: record.workingBranch, status: record.status,
        }
        : selection !== undefined
          ? { repository: selection.repository.fullName, baseBranch: selection.baseBranch, status: 'pending' }
          : {},
    }
  }

  /** The loader entry of this row (the loader augments fibers with it). */
  private get entry(): unknown {
    return (this.owner.fiber as { entry?: unknown }).entry
  }

  /** Apply validated settings to the running manager. */
  private async apply(next: Config): Promise<void> {
    this.config = next
    this.manager.config.image = next.workerImage
    this.manager.config.maxWorkspaces = next.maxWorkspaces
    this.manager.config.previewPorts = next.previewPorts
    this.manager.config.newBranch = next.newBranch
    this.listing = undefined
    Object.assign(this.manager.config, sandboxOptions(next))
    await this.manager.updatePolicy({ mode: next.lockdown ? 'none' : next.network, allow: next.allow, privateAllow: next.privateAllow, ports: next.ports })
    await this.manager.updateLimits({ cpus: next.cpus, memoryMb: next.memoryMb, pids: next.pids, tmpMb: next.tmpMb })
    this.selfTestReport = undefined
  }

  /**
   * Current Settings > Code values.
   * @returns the settings and whether they can be saved to the profile.
   */
  @Remote
  async settings(): Promise<CodeSettingsView> {
    return { settings: settingsOf(this.config), writable: this.ctx.get('configEditor' as never) !== undefined && this.entry !== undefined }
  }

  /**
   * Validate, apply and save Settings > Code. Running workspaces pick up the
   * network policy at once (open tunnels the new policy refuses are closed)
   * and CPU, memory and process limits where the runtime allows; the `/tmp`
   * size and image apply when a workspace restarts. Only the authenticated
   * Code UI reaches this method; agent tools cannot.
   * @param settings - the complete new settings.
   * @returns the saved settings.
   */
  @Remote
  async updateSettings(settings: CodeSettings): Promise<CodeSettingsView> {
    let valid: CodeSettings
    try {
      valid = validateSettings(settings)
    } catch (error) {
      throw remoteFailure(error)
    }
    const editor = this.ctx.get('configEditor' as never) as ConfigEditorFace | undefined
    const entry = this.entry
    const patch = Object.fromEntries(SETTINGS_FIELDS.map(field => [field, valid[field]]))
    if (editor === undefined || entry === undefined) {
      // No profile editor: apply for this run only.
      await this.apply({ ...this.config, ...patch } as Config)
      return { settings: settingsOf(this.config), writable: false }
    }
    try {
      // The edit reloads the row; `internal/update` applies it in place.
      await editor.edit(entry, current => ({ ...current, ...patch }))
    } catch (error) {
      throw remoteFailure(error)
    }
    if (JSON.stringify(settingsOf(this.config)) !== JSON.stringify(valid)) await this.apply({ ...this.config, ...patch } as Config)
    return { settings: settingsOf(this.config), writable: true }
  }

  /**
   * Build the worker image from the bundled Dockerfile, on the user's request.
   * @returns the fresh setup report.
   */
  @Remote
  async buildWorker(): Promise<SelfTestReport> {
    try {
      await this.manager.buildWorker()
    } catch (error) {
      throw remoteFailure(error)
    }
    return this.setupStatus(true)
  }

  /**
   * Resource usage of a session's container.
   * @param sessionId - session id.
   * @returns usage, or null when the workspace is not running.
   */
  @Remote
  async usage(sessionId: string): Promise<WorkspaceUsage | null> {
    return (await this.manager.usage(sessionId).catch(() => undefined)) ?? null
  }

  /**
   * Ports the Preview dialog can offer: what the workspace listens on now, plus declared ports not running yet.
   * @param sessionId - session id.
   * @returns the ports and whether Settings restricts them.
   */
  @Remote
  async previewTargets(sessionId: string): Promise<PreviewTargets> {
    const declared = this.manager.config.previewPorts
    const restricted = declared.length > 0
    let listening: { port: number; localOnly: boolean }[] = []
    try {
      listening = await this.manager.listeningPorts(sessionId)
    } catch (error) {
      throw remoteFailure(error)
    }
    const ports = new Map(listening.map(p => [p.port, p]))
    for (const port of declared) if (!ports.has(port)) ports.set(port, { port, localOnly: false })
    const targets = [...ports.values()].sort((a, b) => a.port - b.port).map(p => ({
      port: p.port, listening: listening.some(l => l.port === p.port), localOnly: p.localOnly, allowed: !restricted || declared.includes(p.port),
    }))
    return { targets, restricted }
  }

  /**
   * Mint an authenticated preview link for a declared container port.
   * @param sessionId - session id.
   * @param port - container port listed in Settings > Code > Preview ports.
   * @returns a same-origin path, valid for eight hours.
   */
  @Remote
  async previewUrl(sessionId: string, port: number): Promise<string> {
    if (this.ctx.get('webServer' as never) === undefined) throw new RemoteError('code/failed', 'previews need the Harness web server (dsh web)', { reason: 'unsupported' })
    try {
      // Without a Preview ports list, only a port something listens on (beyond loopback) gets a link.
      if (this.manager.config.previewPorts.length === 0) {
        const open = (await this.manager.listeningPorts(sessionId)).find(p => p.port === port)
        if (open === undefined) throw new WorkspaceError('unsafe-state', `nothing is listening on port ${port} in this workspace`)
        if (open.localOnly) throw new WorkspaceError('unsafe-state', `port ${port} listens on 127.0.0.1 only; start the app on 0.0.0.0`)
      }
      await this.manager.previewAddress(sessionId, port)
    } catch (error) {
      throw remoteFailure(error)
    }
    return this.previews.mint(sessionId, port)
  }

  /**
   * Mandatory Docker + gVisor checks; Code stays disabled until all pass.
   * @param refresh - rerun instead of returning the cached report.
   * @returns the report.
   */
  @Remote
  async setupStatus(refresh: boolean): Promise<SelfTestReport> {
    if (refresh || this.selfTestReport === undefined) this.selfTestReport = this.manager.selfTest()
    return this.selfTestReport
  }


  /**
   * Whether a session runs in Code mode, read from the Harness every time (never cached here), so it
   * holds across restarts and for sessions that start in Code mode as the default.
   * @param sessionId - session id.
   * @returns true when the session's Agent preset is Code or it has a Code workspace.
   */
  @Remote
  async isCodeMode(sessionId: string): Promise<boolean> {
    if (this.manager.get(sessionId) !== undefined) return true
    const agent = (this.ctx.get('agents') as { get(id: string): Agent | undefined } | undefined)?.get(sessionId)
    if (agent === undefined) return false
    const presets = this.ctx.get('agentPresets') as {
      composedPreset(ctx: unknown): string | undefined
      presetForSession(session: unknown): string | null
      readonly defaultId: string
    } | undefined
    if (presets === undefined) return false
    return (presets.composedPreset(agent.ctx) ?? presets.presetForSession(agent.session) ?? presets.defaultId) === this.config.presetId
  }


  /**
   * Repositories the session's GitHub account can access.
   * @param query - optional filter text.
   * @param sessionId - the session whose account to use; null uses the default account.
   * @returns repositories, most recently updated first.
   */
  @Remote
  async repositories(query: string | null, sessionId: string | null): Promise<RepositorySummary[]> {
    try {
      return await (await this.githubAs(this.accountOf(sessionId))).repositories(query ?? undefined)
    } catch (error) {
      throw remoteFailure(error)
    }
  }

  /**
   * Repositories of every account the gh CLI is signed in with, fetched in parallel. An account
   * whose listing fails is returned with its error instead of failing the whole list.
   * @returns one entry per account, in gh's order.
   */
  @Remote
  async repositoriesByAccount(): Promise<AccountRepositories[]> {
    // Listing every account takes seconds; reopening the menu within 30s reuses the last listing.
    const cached = this.listing
    if (cached !== undefined && Date.now() - cached.at < 30_000) return cached.value
    const value = this.listAllAccounts()
    this.listing = { at: Date.now(), value }
    value.catch(() => { if (this.listing?.value === value) this.listing = undefined })
    return value
  }

  private listing: { readonly at: number; readonly value: Promise<AccountRepositories[]> } | undefined

  private async listAllAccounts(): Promise<AccountRepositories[]> {
    let accounts: { login: string }[]
    try {
      accounts = await this.github.accounts()
    } catch (error) {
      throw remoteFailure(error)
    }
    const disabled = new Set(this.config.disabledAccounts)
    return Promise.all(accounts.filter(a => !disabled.has(a.login)).map(async ({ login }) => {
      try {
        return { login, repositories: await (await this.githubAs(login)).repositories(undefined) }
      } catch (error) {
        return { login, repositories: [], error: error instanceof Error ? error.message : String(error) }
      }
    }))
  }

  /**
   * A session's variables: the Settings defaults and its own values.
   * @param sessionId - session id.
   * @returns both lists as NAME=value lines.
   */
  @Remote
  async sessionVariables(sessionId: string): Promise<SessionVariables> {
    return { defaults: environmentLines(this.manager.config.environment ?? {}), session: environmentLines(await this.manager.sessionEnvironment(sessionId)) }
  }

  /**
   * Replace a session's own variables. They apply from the next command; a running command keeps its values.
   * @param sessionId - session id.
   * @param lines - NAME=value lines; credential-like names are refused.
   * @returns the saved variables.
   */
  @Remote
  async setSessionVariables(sessionId: string, lines: string[]): Promise<SessionVariables> {
    try {
      await this.manager.setSessionEnvironment(sessionId, parseEnvironment(lines))
    } catch (error) {
      if (error instanceof EnvironmentError) throw new RemoteError('code/failed', error.message, { reason: 'invalid-variable' })
      throw remoteFailure(error)
    }
    return this.sessionVariables(sessionId)
  }

  /**
   * Accounts the host's gh CLI is signed in with, for Settings > Code.
   * @returns logins in gh's order.
   */
  @Remote
  async ghAccounts(): Promise<GhAccount[]> {
    try {
      return (await this.github.accounts()).map(a => ({ login: a.login }))
    } catch (error) {
      throw remoteFailure(error)
    }
  }

  /**
   * Branches of one repository, default first.
   * @param repository - `owner/name`.
   * @param sessionId - the session whose account to use; null uses the default account.
   * @returns branches.
   */
  @Remote
  async branches(repository: string, sessionId: string | null): Promise<BranchList> {
    try {
      return await (await this.githubAs(this.accountOf(sessionId))).branches(repository)
    } catch (error) {
      throw remoteFailure(error)
    }
  }

  /**
   * Choose the repository and base branch of a blank Code session. The
   * workspace is provisioned when its first message arrives; the choice is
   * fixed once provisioning starts.
   * @param sessionId - the blank Code session.
   * @param repository - `owner/name`.
   * @param baseBranch - base branch; null selects the default branch.
   * @param account - gh login that clones and pushes; null keeps the session's account.
   * @returns the session view.
   */
  @Remote
  async select(sessionId: string, repository: string, baseBranch: string | null, account: string | null): Promise<CodeSessionView> {
    if (this.manager.get(sessionId) !== undefined) throw new RemoteError('code/failed', 'the repository of a started Code session cannot change', { reason: 'fixed' })
    try {
      if (account !== null && !(await this.github.accounts()).some(a => a.login === account)) {
        throw new RemoteError('code/failed', `gh is not signed in as ${account}`, { reason: 'source-control-auth' })
      }
      const login = account ?? this.accountOf(sessionId)
      const repo = await (await this.githubAs(login)).repository(repository)
      const selection = { repository: repo, baseBranch: baseBranch ?? repo.defaultBranch, account: login }
      this.selections.set(sessionId, selection)
      return view(sessionId, undefined, selection)!
    } catch (error) {
      throw remoteFailure(error)
    }
  }

  /**
   * Code session ids known on this host, for the sidebar Code filter.
   * @returns every selected or provisioned session.
   */
  @Remote
  async sessions(): Promise<CodeSessionView[]> {
    const ids = new Set([...this.selections.keys(), ...this.manager.list().map(r => r.sessionId)])
    return [...ids].flatMap(id => view(id, this.manager.get(id), this.selections.get(id)) ?? [])
  }

  /**
   * State of one Code session.
   * @param sessionId - session id.
   * @returns its view, or null when it is not a Code session.
   */
  @Remote
  async session(sessionId: string): Promise<CodeSessionView | null> {
    return view(sessionId, this.manager.get(sessionId), this.selections.get(sessionId)) ?? null
  }

  /**
   * Diff of the checkout against its pinned base commit.
   * @param sessionId - session id.
   * @returns unified diff.
   */
  @Remote
  async diff(sessionId: string): Promise<string> {
    try {
      return await this.manager.diff(sessionId)
    } catch (error) {
      throw remoteFailure(error)
    }
  }

  /**
   * Work that deleting the workspace would lose.
   * @param sessionId - session id.
   * @returns counts, or null when the workspace is unavailable.
   */
  @Remote
  async pendingWork(sessionId: string): Promise<PendingWork | null> {
    return (await this.manager.pendingWork(sessionId).catch(() => undefined)) ?? null
  }

  /**
   * Commit all changes and push the session's working branch.
   * @param sessionId - session id.
   * @param message - commit message.
   * @returns pushed commit and branch.
   */
  @Remote
  async commitAndPush(sessionId: string, message: string): Promise<PushResult> {
    try {
      return await this.manager.commitAndPush(sessionId, message)
    } catch (error) {
      throw remoteFailure(error)
    }
  }

  /**
   * Commit, push and open a pull request into the base branch.
   * @param sessionId - session id.
   * @param title - pull request title.
   * @param body - pull request body.
   * @returns the pull request URL.
   */
  @Remote
  async createPullRequest(sessionId: string, title: string, body: string): Promise<string> {
    const record = this.manager.get(sessionId)
    if (record === undefined) throw new RemoteError('code/failed', 'not a Code session', { reason: 'not-found' })
    if (record.workingBranch === record.baseBranch) {
      throw new RemoteError('code/failed', `this session works directly on ${record.baseBranch}; turn on "Always create a new branch" in Settings > Code to open pull requests`, { reason: 'same-branch' })
    }
    try {
      await this.manager.commitAndPush(sessionId, title)
      return await (await this.githubAs(record.account ?? '')).createPullRequest(record.repository.fullName, record.workingBranch, record.baseBranch, title, body)
    } catch (error) {
      throw remoteFailure(error)
    }
  }

  /**
   * Restart the worker container, keeping the checkout.
   * @param sessionId - session id.
   * @returns the session view.
   */
  @Remote
  async restart(sessionId: string): Promise<CodeSessionView> {
    try {
      this.steps.set(sessionId, [])
      const record = await this.manager.restart(sessionId, (name) => { this.recordStep(sessionId, name) })
      this.recordStep(sessionId, 'ready')
      return view(sessionId, record, undefined)!
    } catch (error) {
      throw remoteFailure(error)
    }
  }

  /**
   * Delete the container, checkout and mirror. Remote branches and pull
   * requests remain. The UI shows {@link pendingWork} first.
   * @param sessionId - session id.
   */
  @Remote
  async deleteWorkspace(sessionId: string): Promise<void> {
    this.selections.delete(sessionId)
    this.previews.revoke(sessionId)
    try {
      await this.manager.delete(sessionId)
    } catch (error) {
      throw remoteFailure(error)
    }
  }
}

export type { SessionId }
export default CodeWorkspacesService
