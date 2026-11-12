/**
 * Code plugin, browser half. A session becomes a Code session when "Code
 * mode" is chosen in the Harness mode selector: a session that chose it
 * outside the Code Workspace is replaced by a blank Code session there, so
 * Code sessions group under one sidebar Workspace. A Code session gets
 * Repository and Branch rows in the composer's + menu, a status line above
 * the composer naming the choice and the workspace state, and Diff /
 * Create PR / Restart / Delete actions in its header. Everything uses
 * documented Harness extension points; the Harness needs no changes.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import remote from '@gabrielbav/dsh-code/remote'
import type { AccountList, CodeSessionView, RepositorySummary, BranchList, PendingWork, SelfTestReport, PushResult, SessionEnvironment } from '../types.ts'
import { IconBranchOutlineRegular, IconFolderOpenOutlineRegular, IconUserOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { EnvironmentView, SessionActions, WorkspaceStatusLine, type Outcome } from './components.tsx'
import { cell, sameIds, type Cell } from './store.ts'
import { en, NS, zh } from './locales.ts'

/** Preset id the bundle patch declares for Code sessions. */
const PRESET_ID = 'code'
const POLL_MS = 2000

type Result<V> = { readonly ok: true; readonly value: V } | { readonly ok: false; readonly error: { readonly message: string } }

/** The Remote namespace generated from the Host service. */
interface CodeRemote {
  setupStatus(refresh: boolean): Promise<Result<SelfTestReport>>
  homeWorkspace(): Promise<Result<string>>
  isCodeMode(sessionId: string): Promise<Result<boolean>>
  inHomeWorkspace(sessionId: string): Promise<Result<boolean>>
  repositories(query: string | null, sessionId: string | null): Promise<Result<RepositorySummary[]>>
  branches(repository: string, sessionId: string | null): Promise<Result<BranchList>>
  accounts(sessionId: string): Promise<Result<AccountList>>
  chooseAccount(sessionId: string, login: string): Promise<Result<CodeSessionView | null>>
  environment(sessionId: string): Promise<Result<SessionEnvironment>>
  select(sessionId: string, repository: string, baseBranch: string | null): Promise<Result<CodeSessionView>>
  sessions(): Promise<Result<CodeSessionView[]>>
  diff(sessionId: string): Promise<Result<string>>
  pendingWork(sessionId: string): Promise<Result<PendingWork | null>>
  commitAndPush(sessionId: string, message: string): Promise<Result<PushResult>>
  createPullRequest(sessionId: string, title: string, body: string): Promise<Result<string>>
  restart(sessionId: string): Promise<Result<CodeSessionView>>
  deleteWorkspace(sessionId: string): Promise<Result<void>>
}

interface UiWorkspaceFace {
  startSession(workspaceId?: string, options?: { readonly agentPreset?: string }): void
}

/** The parts of `ctx.commandUi` (ui-commands) this plugin uses: rows of the composer's + and / menu. */
interface CommandOption { readonly id: string; readonly label: string; readonly detail?: string; readonly active?: boolean }
interface CommandUiFace {
  register(contribution: {
    readonly name: string
    label(): string
    description(): string
    readonly icon: unknown
    available(session: { readonly sessionId: string }): boolean
    readonly ui: {
      readonly kind: 'popupSelect'
      searchLabels(): { readonly placeholder: string; readonly empty: string; readonly noResults: string }
      options(session: { readonly sessionId: string }, signal: AbortSignal): Promise<readonly CommandOption[]>
      onSelect(option: CommandOption, session: { readonly sessionId: string }): Promise<void>
    }
  }): () => void
}

/** The parts of the Client context this plugin uses. */
interface ClientFace {
  readonly slots: {
    inject(name: string, factory: () => () => void): void
    register(options: { readonly name: string; readonly id: string; readonly order?: number; readonly locale?: string; readonly label?: () => string; readonly inject?: (sessionId: string) => object }, component: ComponentType<never>): () => void
  }
  readonly locale: {
    register(ns: string, dicts: Record<string, Record<string, string>>): () => void
    bind(ns: string): (key: string, params?: Record<string, string>) => string
  }
  readonly remote: {
    $mount(contribution: unknown): Promise<() => Promise<void> | void>
    $on(event: 'agent-preset/selected', listener: (sessionId: string, agentPreset: string) => void): () => void
    readonly codeWorkspaces: CodeRemote
    readonly agentPresets?: { select(sessionId: string, presetId: string): Promise<Result<string>> }
  }
}

/** Required Client services. */
export const inject = ['slots', 'locale', 'remote']

function outcome<V>(result: Result<V>): Outcome<V> {
  return result.ok ? { ok: true, value: result.value } : { ok: false, message: result.error.message }
}

/**
 * Client plugin body.
 * @param ctx - Client root context.
 */
export async function apply(ctx: Context): Promise<void> {
  const face = ctx as unknown as ClientFace & Context
  ctx.effect(() => face.locale.register(NS, { en, zh }), 'dsh-code: locale')
  const unmount = await face.remote.$mount(remote)
  ctx.effect(() => () => { void unmount() }, 'dsh-code: remote')
  ctx.inject(['remote.codeWorkspaces', 'slots', 'locale'], (inner) => { register(inner) })
}

function register(ctx: Context): void {
  const face = ctx as unknown as ClientFace & Context
  // Read the Remote once: a popup or timer can outlive this context, and reading ctx.remote
  // on an inactive context throws ("cannot get required service remote").
  const codeRemote = face.remote.codeWorkspaces
  const api = (): CodeRemote => codeRemote

  const t = face.locale.bind(NS)
  /** Sessions with a repository selected or a provisioned workspace. */
  const codeIds = cell<ReadonlySet<string>>(new Set(), sameIds)
  /**
   * Sessions in Code mode. A cache of the Host's answer only: every entry is fetched from
   * `isCodeMode`, refreshed on the mode event and on each poll, and never decided here.
   */
  const presetIds = cell<ReadonlySet<string>>(new Set(), sameIds)
  const known = new Set<string>()
  const checkMode = async (sessionId: string): Promise<void> => {
    known.add(sessionId)
    const result = await api().isCodeMode(sessionId).catch(() => undefined)
    if (result === undefined || !result.ok) return
    const next = new Set(presetIds.getSnapshot())
    if (result.value) next.add(sessionId)
    else next.delete(sessionId)
    presetIds.set(next)
  }
  const watch = (sessionId: string): void => { if (!known.has(sessionId)) void checkMode(sessionId) }
  const isCode = (sessionId: string): boolean => {
    watch(sessionId)
    return presetIds.getSnapshot().has(sessionId)
  }
  const views = new Map<string, Cell<CodeSessionView | null>>()
  const viewOf = (sessionId: string): Cell<CodeSessionView | null> => {
    let entry = views.get(sessionId)
    if (entry === undefined) {
      entry = cell<CodeSessionView | null>(null, (a, b) => JSON.stringify(a) === JSON.stringify(b))
      views.set(sessionId, entry)
    }
    return entry
  }

  const refresh = async (): Promise<void> => {
    const result = await api().sessions().catch(() => undefined)
    if (result === undefined || !result.ok) return
    codeIds.set(new Set(result.value.map(v => v.sessionId)))
    await Promise.all([...known].map(checkMode))
    const seen = new Set<string>()
    for (const v of result.value) {
      viewOf(v.sessionId).set(v)
      seen.add(v.sessionId)
    }
    for (const [id, entry] of views) if (!seen.has(id)) entry.set(null)
  }
  ctx.effect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => { clearInterval(timer) }
  }, 'dsh-code: session state')

  const uiWorkspace = (): UiWorkspaceFace | undefined => {
    try {
      return ctx.get('uiWorkspace' as never) as UiWorkspaceFace | undefined
    } catch {
      // The context was disposed (reconnect or reload); its replacement handles the next selection.
      return undefined
    }
  }
  const home = cell<string | null>(null)
  const ensureHome = async (): Promise<string | undefined> => {
    const known = home.getSnapshot()
    if (known !== null) return known
    const result = await api().homeWorkspace().catch(() => undefined)
    if (result === undefined || !result.ok) return undefined
    home.set(result.value)
    return result.value
  }
  // Choosing Code mode on a session outside the Code Workspace starts a blank Code session there instead:
  // Workspace membership is fixed at creation. The new session's own selection finds it already home.
  ctx.effect(() => face.remote.$on('agent-preset/selected', (rawId, agentPreset) => {
    const sessionId = String(rawId)
    void checkMode(sessionId)
    if (agentPreset !== PRESET_ID) {
      void refresh()
      return
    }
    void api().inHomeWorkspace(sessionId).then(async (home) => {
      if (!home.ok || home.value) return
      const workspaceId = await ensureHome()
      if (workspaceId !== undefined) uiWorkspace()?.startSession(workspaceId, { agentPreset: PRESET_ID })
    }).catch(() => undefined)
  }), 'dsh-code: Code mode moves into the Code Workspace')

  const selectFor = async (sessionId: string, repository: string, branch: string | null): Promise<Outcome<CodeSessionView>> => {
    const result = outcome(await api().select(sessionId, repository, branch))
    if (result.ok) {
      viewOf(sessionId).set(result.value)
      codeIds.set(new Set([...codeIds.getSnapshot(), sessionId]))
    }
    return result
  }
  const editable = (sessionId: string): boolean => {
    const view = viewOf(sessionId).getSnapshot()
    return isCode(sessionId) && (view === null || view.status === 'pending')
  }
  const fail = (result: Outcome<unknown>): never => { throw new Error(result.ok ? '' : result.message) }

  // Account, Repository and Branch in the composer's + menu (also reachable as /account, /repository and /branch).
  ctx.inject(['commandUi'], (scope) => {
    const commands = scope.get('commandUi' as never) as unknown as CommandUiFace
    scope.effect(() => commands.register({
      name: 'account',
      label: () => t('command.account'),
      description: () => t('command.accountDescription'),
      icon: IconUserOutlineRegular,
      available: session => editable(String(session.sessionId)),
      ui: {
        kind: 'popupSelect',
        searchLabels: () => ({ placeholder: t('command.searchAccounts'), empty: t('command.noAccounts'), noResults: t('command.noMatch') }),
        options: async (session) => {
          const list = outcome(await api().accounts(String(session.sessionId)))
          if (!list.ok) return fail(list)
          // `active` only parks the keyboard highlight, so the account in use is also named in the row.
          return list.value.accounts.map((account) => {
            const inUse = account.login === list.value.current
            const notes = [...inUse ? [t('command.inUse')] : [], ...account.active ? [t('command.activeAccount')] : []]
            return { id: account.login, label: account.login, active: inUse, ...notes.length > 0 ? { detail: notes.join(' · ') } : {} }
          })
        },
        onSelect: async (option, session) => {
          const sessionId = String(session.sessionId)
          const result = outcome(await api().chooseAccount(sessionId, option.id))
          if (!result.ok) fail(result)
          else {
            viewOf(sessionId).set(result.value)
            if (result.value === null) codeIds.set(new Set([...codeIds.getSnapshot()].filter(id => id !== sessionId)))
          }
        },
      },
    }), 'dsh-code: + menu account')
    scope.effect(() => commands.register({
      name: 'repository',
      label: () => t('command.repository'),
      description: () => t('command.repositoryDescription'),
      icon: IconFolderOpenOutlineRegular,
      available: session => editable(String(session.sessionId)),
      ui: {
        kind: 'popupSelect',
        searchLabels: () => ({ placeholder: t('picker.search'), empty: t('command.noRepositories'), noResults: t('command.noMatch') }),
        options: async (session) => {
          const current = viewOf(String(session.sessionId)).getSnapshot()?.repository
          const list = outcome(await api().repositories(null, String(session.sessionId)))
          if (!list.ok) return fail(list)
          return list.value.map(repo => ({ id: repo.fullName, label: repo.fullName, active: repo.fullName === current, ...repo.fullName === current ? { detail: t('command.inUse') } : {} }))
        },
        onSelect: async (option, session) => {
          const result = await selectFor(String(session.sessionId), option.id, null)
          if (!result.ok) fail(result)
        },
      },
    }), 'dsh-code: + menu repository')
    scope.effect(() => commands.register({
      name: 'branch',
      label: () => t('command.branch'),
      description: () => t('command.branchDescription'),
      icon: IconBranchOutlineRegular,
      available: session => editable(String(session.sessionId)) && viewOf(String(session.sessionId)).getSnapshot() !== null,
      ui: {
        kind: 'popupSelect',
        searchLabels: () => ({ placeholder: t('command.searchBranches'), empty: t('command.noBranches'), noResults: t('command.noMatch') }),
        options: async (session) => {
          const view = viewOf(String(session.sessionId)).getSnapshot()
          if (view === null) throw new Error(t('command.chooseRepositoryFirst'))
          const list = outcome(await api().branches(view.repository, String(session.sessionId)))
          if (!list.ok) return fail(list)
          return list.value.branches.map(name => ({
            id: name, label: name, active: name === view.baseBranch,
            ...name === view.baseBranch || name === list.value.defaultBranch
              ? { detail: [...name === view.baseBranch ? [t('command.inUse')] : [], ...name === list.value.defaultBranch ? [t('command.defaultBranch')] : []].join(' · ') }
              : {},
          }))
        },
        onSelect: async (option, session) => {
          const sessionId = String(session.sessionId)
          const view = viewOf(sessionId).getSnapshot()
          if (view === null) throw new Error(t('command.chooseRepositoryFirst'))
          const result = await selectFor(sessionId, view.repository, option.id)
          if (!result.ok) fail(result)
        },
      },
    }), 'dsh-code: + menu branch')
  })

  face.slots.inject('conversation.view', () => face.slots.register({
    name: 'conversation.view', id: 'dsh-code.environment', order: 20, locale: NS,
    label: () => t('view.environment'),
    inject: (sessionId: string) => {
      watch(sessionId)
      return { hooks: { view: viewOf(sessionId), presetIds }, load: async () => outcome(await api().environment(sessionId)) }
    },
  }, EnvironmentView as ComponentType<never>))

  face.slots.inject('conversation.input.dock', () => face.slots.register({
    name: 'conversation.input.dock', id: 'dsh-code.status', order: 20, locale: NS,
    inject: (sessionId: string) => {
      watch(sessionId)
      return { hooks: { view: viewOf(sessionId), presetIds }, sessionId }
    },
  }, WorkspaceStatusLine as ComponentType<never>))

  face.slots.inject('conversation.session.header.actions', () => face.slots.register({
    name: 'conversation.session.header.actions', id: 'dsh-code.actions', order: 50, locale: NS,
    inject: (sessionId: string) => ({
      hooks: { view: viewOf(sessionId) },
      diff: async () => outcome(await api().diff(sessionId)),
      pendingWork: async () => outcome(await api().pendingWork(sessionId)),
      createPullRequest: async (title: string, body: string) => outcome(await api().createPullRequest(sessionId, title, body)),
      restart: async () => {
        const result = outcome(await api().restart(sessionId))
        if (result.ok) viewOf(sessionId).set(result.value)
        return result
      },
      remove: async () => {
        const result = outcome(await api().deleteWorkspace(sessionId))
        if (result.ok) void refresh()
        return result
      },
    }),
  }, SessionActions as ComponentType<never>))
}
