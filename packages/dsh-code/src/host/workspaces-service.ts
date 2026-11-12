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
import { mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-workspace'
import { WorkspaceError, WorkspaceManager, type WorkspaceRecord } from '../core/workspaces.ts'
import { GitHubProvider, SourceControlError } from '../core/github.ts'
import type { AccountList, BranchList, CodeSessionView, PendingWork, PushResult, RepositorySummary, SelfTestReport, SessionEnvironment } from '../types.ts'
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
  presetId: string
  defaultAccount: string
}

export const Config: z<Config> = z.object({
  // A root host keeps data outside /root, which the non-root container user cannot traverse.
  dataDir: z.string().default(process.getuid?.() === 0 ? '/var/lib/dsh-code' : join(homedir(), '.dsh-code')).description('Workspaces, mirrors and records'),
  workerImage: z.string().default('dsh-code-worker:0.1.0').description('Worker image; pin by digest in production'),
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
  presetId: z.string().default('code'),
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
  return new RemoteError('code/failed', error instanceof Error ? error.message : String(error), { reason: 'failed' })
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A Code operation failed; `reason` names the recovery path. */
    'code/failed': { readonly reason: string }
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
  /** Accounts chosen in the + menu before a repository; a selection or a record carries its own. */
  private readonly accountChoices = new Map<string, string>()
  private selfTestReport: Promise<SelfTestReport> | undefined

  /**
   * @param ctx - host context.
   * @param config - validated configuration.
   */
  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'codeWorkspaces')
    this.manager = new WorkspaceManager({
      dataDir: config.dataDir, image: config.workerImage, proxyImage: config.proxyImage,
      proxyDir: join(import.meta.dirname, '..', 'egress'),
      limits: { cpus: config.cpus, memoryMb: config.memoryMb, pids: config.pids, tmpMb: config.tmpMb },
      policy: { mode: config.network, allow: config.allow, privateAllow: config.privateAllow, ports: config.ports },
      uid: config.uid, gid: config.gid, maxWorkspaces: config.maxWorkspaces,
    }, undefined, new Git(gitRunner('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'])),
    async account => this.github.credentials(account))
    ctx.effect(() => {
      const lifetime = new AbortController()
      void this.manager.reconcile().catch((error: unknown) => { ctx.logger('dsh-code').warn('reconcile failed: %s', String(error)) })
      return () => { lifetime.abort() }
    }, 'dsh-code: reconcile workspaces')
    ctx.effect(() => ctx.on('agent/inbox/inserted', ({ agent }) => { this.hold(agent) }), 'dsh-code: hold first message until provisioned')
    // The mode selector is how a session becomes a Code session; the agent-preset registry re-emits each committed choice.
    const presetEvents = ctx as unknown as { on(name: 'agent-preset/selected', listener: (sessionId: string, agentPreset: string) => void): () => void }
    // Leaving Code mode before the first message drops the session's unprovisioned choices.
    ctx.effect(() => presetEvents.on('agent-preset/selected', (sessionId, agentPreset) => {
      if (agentPreset === config.presetId || this.manager.get(String(sessionId)) !== undefined) return
      this.selections.delete(String(sessionId))
      this.accountChoices.delete(String(sessionId))
    }), 'dsh-code: leaving Code mode clears choices')
    ctx.effect(() => ctx.on('workspace/session-archived', ({ sessionId }) => {
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
          ? await this.manager.provision(sessionId, selection!.repository, selection!.baseBranch, undefined, selection!.account)
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

  /** The account a session uses: its record, its selection, a + menu choice, then the configured default. */
  private accountOf(sessionId: string | null): string {
    if (sessionId === null) return this.config.defaultAccount
    return this.manager.get(sessionId)?.account ?? this.selections.get(sessionId)?.account
      ?? this.accountChoices.get(sessionId) ?? this.config.defaultAccount
  }

  private async githubAs(account: string): Promise<GitHubProvider> {
    return account === '' ? this.github : this.github.withEnv(await this.github.credentials(account))
  }

  /**
   * GitHub accounts this session can use.
   * @param sessionId - session id.
   * @returns the gh CLI's signed-in accounts and the session's current one.
   */
  @Remote
  async accounts(sessionId: string): Promise<AccountList> {
    try {
      const accounts = await this.github.accounts()
      const chosen = this.accountOf(sessionId)
      return { accounts, current: chosen !== '' ? chosen : accounts.find(a => a.active)?.login ?? '' }
    } catch (error) {
      throw remoteFailure(error)
    }
  }

  /**
   * Choose the GitHub account of a blank Code session. A repository chosen with
   * another account is dropped, since this account may not reach it.
   * @param sessionId - session id.
   * @param login - gh login.
   * @returns the session view, or null when no repository is chosen.
   */
  @Remote
  async chooseAccount(sessionId: string, login: string): Promise<CodeSessionView | null> {
    if (this.manager.get(sessionId) !== undefined) throw new RemoteError('code/failed', 'the account of a started Code session cannot change', { reason: 'fixed' })
    try {
      if (!(await this.github.accounts()).some(a => a.login === login)) throw new RemoteError('code/failed', `gh is not signed in as ${login}`, { reason: 'source-control-auth' })
    } catch (error) {
      throw error instanceof RemoteError ? error : remoteFailure(error)
    }
    const previous = this.selections.get(sessionId)
    this.accountChoices.set(sessionId, login)
    if (previous !== undefined && previous.account !== login) this.selections.delete(sessionId)
    return view(sessionId, undefined, this.selections.get(sessionId)) ?? null
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
    return {
      mode: 'code',
      ...workingDirectory === undefined ? {} : { workingDirectory },
      ...login === undefined ? {} : { account: login },
      ...record !== undefined
        ? {
          repository: record.repository.fullName, baseBranch: record.baseBranch, baseCommit: record.baseCommit,
          workingBranch: record.workingBranch, status: record.status,
          container: {
            name: record.containerName, image: record.image, runtime: record.runtime, network: this.config.network,
            cpus: this.config.cpus, memoryMb: this.config.memoryMb,
          },
        }
        : selection !== undefined
          ? { repository: selection.repository.fullName, baseBranch: selection.baseBranch, status: 'pending' }
          : {},
    }
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
   * Whether a session was created in the Code Workspace. Workspace membership
   * is fixed when a session is created, so a session that chose Code mode
   * elsewhere is replaced by a blank Code session there.
   * @param sessionId - session id.
   * @returns true when the session's recorded directory is the Code Workspace.
   */
  @Remote
  async inHomeWorkspace(sessionId: string): Promise<boolean> {
    const agents = this.ctx.get('agents') as { get(id: string): Agent | undefined } | undefined
    const cwd = agents?.get(sessionId)?.session.header.cwd
    if (cwd === undefined) return false
    const canonical = async (path: string): Promise<string> => realpath(path).catch(() => path)
    return await canonical(cwd) === await canonical(join(this.config.dataDir, 'sessions'))
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
   * @returns the session view.
   */
  @Remote
  async select(sessionId: string, repository: string, baseBranch: string | null): Promise<CodeSessionView> {
    if (this.manager.get(sessionId) !== undefined) throw new RemoteError('code/failed', 'the repository of a started Code session cannot change', { reason: 'fixed' })
    try {
      const account = this.accountOf(sessionId)
      const repo = await (await this.githubAs(account)).repository(repository)
      const selection = { repository: repo, baseBranch: baseBranch ?? repo.defaultBranch, account }
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
    this.accountChoices.delete(sessionId)
    try {
      await this.manager.delete(sessionId)
    } catch (error) {
      throw remoteFailure(error)
    }
  }
}

export type { SessionId }
export default CodeWorkspacesService
