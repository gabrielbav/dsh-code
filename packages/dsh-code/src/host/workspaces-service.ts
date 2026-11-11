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
import { mkdir } from 'node:fs/promises'
import { mkdirSync, realpathSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-workspace'
import { WorkspaceError, WorkspaceManager, type WorkspaceRecord } from '../core/workspaces.ts'
import { GitHubProvider, SourceControlError } from '../core/github.ts'
import type { BranchList, CodeSessionView, CodeSettings, CodeSettingsView, PendingWork, PushResult, RepositorySummary, SelfTestReport, WorkspaceUsage } from '../types.ts'
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
})

interface Selection {
  readonly repository: RepositorySummary
  readonly baseBranch: string
}

function view(sessionId: string, record: WorkspaceRecord | undefined, selection: Selection | undefined): CodeSessionView | undefined {
  if (record !== undefined) {
    return {
      sessionId, repository: record.repository.fullName, baseBranch: record.baseBranch, baseCommit: record.baseCommit,
      workingBranch: record.workingBranch, status: record.status, ...(record.error === undefined ? {} : { error: record.error }),
    }
  }
  if (selection !== undefined) return { sessionId, repository: selection.repository.fullName, baseBranch: selection.baseBranch, status: 'pending' }
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
      policy: { mode: config.network, allow: config.allow, privateAllow: config.privateAllow, ports: config.ports },
      uid: config.uid, gid: config.gid, maxWorkspaces: config.maxWorkspaces, previewPorts: config.previewPorts,
    }, undefined, new Git(gitRunner('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'])))
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
    ctx.effect(() => ctx.on('agent/inbox/inserted', ({ agent }) => { this.hold(agent) }), 'dsh-code: hold first message until provisioned')
    ctx.effect(() => ctx.on('workspace/session-archived', ({ sessionId }) => {
      this.previews.revoke(sessionId)
      void this.manager.delete(sessionId).catch((error: unknown) => { ctx.logger('dsh-code').warn('cleanup of %s failed: %s', sessionId, String(error)) })
    }), 'dsh-code: delete workspace on archive')
  }

  private hold(agent: Agent): void {
    const sessionId = String(agent.id)
    const record = this.manager.get(sessionId)
    const selection = this.selections.get(sessionId)
    const needsWork = selection !== undefined && record === undefined
      || record !== undefined && (record.status === 'offline' || record.status === 'failed')
    if (!needsWork) return
    try {
      void agent.runMaintenance(async (signal) => {
        await Promise.resolve()
        if (signal.aborted) return
        const ready = record === undefined
          ? await this.manager.provision(sessionId, selection!.repository, selection!.baseBranch)
          : await this.manager.restart(sessionId)
        await this.ctx.workingDirectory.set(agent, ready.path, signal)
        this.selections.delete(sessionId)
      }).catch((error: unknown) => { this.ctx.logger('dsh-code').warn('provisioning %s failed: %s', sessionId, String(error)) })
    } catch (error) {
      // A turn or maintenance already owns the Agent; the message proceeds and
      // the preset's providers refuse to run outside a ready workspace.
      this.ctx.logger('dsh-code').debug('hold skipped for %s: %s', sessionId, String(error))
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
    await this.manager.updatePolicy({ mode: next.network, allow: next.allow, privateAllow: next.privateAllow, ports: next.ports })
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
   * Mint an authenticated preview link for a declared container port.
   * @param sessionId - session id.
   * @param port - container port listed in Settings > Code > Preview ports.
   * @returns a same-origin path, valid for eight hours.
   */
  @Remote
  async previewUrl(sessionId: string, port: number): Promise<string> {
    if (this.ctx.get('webServer' as never) === undefined) throw new RemoteError('code/failed', 'previews need the Harness web server (dsh web)', { reason: 'unsupported' })
    try {
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
   * Ensure the Harness Workspace that groups Code sessions in the sidebar.
   * Blank Code sessions start there; each one moves its working directory
   * into its own checkout when it is provisioned.
   * @returns the Workspace id.
   */
  @Remote
  async homeWorkspace(): Promise<string> {
    const registry = this.ctx.get('workspaceRegistry') as { create(path: string, title?: string): Promise<{ readonly id: string }> } | undefined
    if (registry === undefined) throw new RemoteError('code/failed', 'this Harness has no workspace registry', { reason: 'unsupported' })
    const path = join(this.config.dataDir, 'sessions')
    await mkdir(path, { recursive: true })
    return String((await registry.create(path, 'Code')).id)
  }

  /**
   * Repositories the host's source control identity can access.
   * @param query - optional filter text.
   * @returns repositories, most recently updated first.
   */
  @Remote
  async repositories(query: string | null): Promise<RepositorySummary[]> {
    try {
      return await this.github.repositories(query ?? undefined)
    } catch (error) {
      throw remoteFailure(error)
    }
  }

  /**
   * Branches of one repository, default first.
   * @param repository - `owner/name`.
   * @returns branches.
   */
  @Remote
  async branches(repository: string): Promise<BranchList> {
    try {
      return await this.github.branches(repository)
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
   * @returns the session view.
   */
  @Remote
  async select(sessionId: string, repository: string, baseBranch: string | null): Promise<CodeSessionView> {
    if (this.manager.get(sessionId) !== undefined) throw new RemoteError('code/failed', 'the repository of a started Code session cannot change', { reason: 'fixed' })
    try {
      const repo = await this.github.repository(repository)
      const selection = { repository: repo, baseBranch: baseBranch ?? repo.defaultBranch }
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
    try {
      await this.manager.commitAndPush(sessionId, title)
      return await this.github.createPullRequest(record.repository.fullName, record.workingBranch, record.baseBranch, title, body)
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
      const record = await this.manager.restart(sessionId)
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
