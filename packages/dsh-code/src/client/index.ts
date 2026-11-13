/**
 * Code plugin, browser half. A session becomes a Code session when "Code
 * mode" is chosen in the Harness mode selector, in whatever Workspace the user
 * picked; from the first message it works in its own checkout. A Code session
 * gets Repository and Branch rows in the composer's + menu, the choice beside
 * the + button, setup and workspace status above the composer, Preview and
 * Delete session in its header, an Environment tab, and a Settings > Code
 * page. Everything uses documented Harness extension points; the Harness
 * needs no changes.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import remote from '@gabrielbav/dsh-code/remote'
import type { AccountRepositories, BrowserAction, GhAccount, IsolatedFrame, PreviewTargets, SessionOverrides, SessionOverridesView, SessionVariables, CodeSessionView, CodeSettings, CodeSettingsView, RepositorySummary, BranchList, PendingWork, SelfTestReport, PushResult, SessionEnvironment, WorkspaceUsage } from '../types.ts'
import { IconBranchOutlineRegular, IconFolderOpenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { CodeSettingsSection, EnvironmentTab, PreviewTab, SelectionLabel, SessionActions, SetupNotice, WorkspaceStatusLine, type Outcome } from './components.tsx'
import { cell, sameIds, type Cell } from './store.ts'
import { en, NS, zh } from './locales.ts'

/** Preset id the bundle patch declares for Code sessions. */
const PRESET_ID = 'code'
const POLL_MS = 2000

type Result<V> = { readonly ok: true; readonly value: V } | { readonly ok: false; readonly error: { readonly message: string } }

/** The Remote namespace generated from the Host service. */
interface CodeRemote {
  setupStatus(refresh: boolean): Promise<Result<SelfTestReport>>
  isCodeMode(sessionId: string): Promise<Result<boolean>>
  repositories(query: string | null, sessionId: string | null): Promise<Result<RepositorySummary[]>>
  branches(repository: string, sessionId: string | null): Promise<Result<BranchList>>
  repositoriesByAccount(): Promise<Result<AccountRepositories[]>>
  ghAccounts(): Promise<Result<GhAccount[]>>
  previewTargets(sessionId: string): Promise<Result<PreviewTargets>>
  sessionOverrides(sessionId: string): Promise<Result<SessionOverridesView>>
  browserFrame(sessionId: string, port: number, after: number): Promise<Result<IsolatedFrame | null>>
  browserInput(sessionId: string, action: BrowserAction): Promise<Result<boolean>>
  browserStop(sessionId: string): Promise<Result<void>>
  setSessionOverrides(sessionId: string, overrides: SessionOverrides): Promise<Result<SessionOverridesView>>
  sessionVariables(sessionId: string): Promise<Result<SessionVariables>>
  setSessionVariables(sessionId: string, lines: string[]): Promise<Result<SessionVariables>>
  networkGrants(sessionId: string): Promise<Result<string[]>>
  revokeNetworkGrant(sessionId: string, host: string): Promise<Result<string[]>>
  environment(sessionId: string): Promise<Result<SessionEnvironment>>
  select(sessionId: string, repository: string, baseBranch: string | null, account: string | null): Promise<Result<CodeSessionView>>
  sessions(): Promise<Result<CodeSessionView[]>>
  diff(sessionId: string): Promise<Result<string>>
  pendingWork(sessionId: string): Promise<Result<PendingWork | null>>
  commitAndPush(sessionId: string, message: string): Promise<Result<PushResult>>
  createPullRequest(sessionId: string, title: string, body: string): Promise<Result<string>>
  restart(sessionId: string): Promise<Result<CodeSessionView>>
  deleteWorkspace(sessionId: string): Promise<Result<void>>
  buildWorker(): Promise<Result<SelfTestReport>>
  usage(sessionId: string): Promise<Result<WorkspaceUsage | null>>
  previewUrl(sessionId: string, port: number): Promise<Result<string>>
  settings(): Promise<Result<CodeSettingsView>>
  updateSettings(settings: CodeSettings): Promise<Result<CodeSettingsView>>
}

/** The parts of `ctx.commandUi` (ui-commands) this plugin uses: rows of the composer's + and / menu. */
interface CommandOption {
  readonly id: string
  readonly label: string
  readonly detail?: string
  readonly active?: boolean
  readonly group?: { readonly name: string; readonly label: string }
}
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

  // A Code session stays in the Workspace the user picked; its work happens in the checkout, which its working
  // directory moves into on the first message. Mode changes only refresh what the client knows.
  ctx.effect(() => face.remote.$on('agent-preset/selected', (rawId, agentPreset) => {
    void checkMode(String(rawId))
    if (agentPreset !== PRESET_ID) void refresh()
  }), 'dsh-code: follow mode changes')

  /** @returns undefined when the session is gone, else why it could not be removed. */
  const removeSession = async (sessionId: string): Promise<string | undefined> => {
    const connection = (() => {
      try { return ctx.get('connection' as never) as { rpc?: { call(channel: string, method: string, payload: unknown): Promise<Result<unknown>> } } | undefined } catch { return undefined }
    })()
    const permanent = await connection?.rpc?.call('/api', 'sessionDelete.deleteSession', { sessionId }).catch(() => undefined)
    if (permanent?.ok === true) return undefined
    try {
      const ws = ctx.get('uiWorkspace' as never) as { archiveSession(id: string, options?: { readonly stopActivity?: boolean }): Promise<void> } | undefined
      if (ws === undefined) return t('delete.sessionUnavailable')
      await ws.archiveSession(sessionId, { stopActivity: true })
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  const selectFor = async (sessionId: string, repository: string, branch: string | null, account: string | null = null): Promise<Outcome<CodeSessionView>> => {
    const result = outcome(await api().select(sessionId, repository, branch, account))
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

  // Repository and Branch in the composer's + menu (also reachable as /repository and /branch). Repository lists
  // every signed-in gh account's repositories grouped by account; the group picked decides the account.
  ctx.inject(['commandUi'], (scope) => {
    const commands = scope.get('commandUi' as never) as unknown as CommandUiFace
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
          const view = viewOf(String(session.sessionId)).getSnapshot()
          const list = outcome(await api().repositoriesByAccount())
          if (!list.ok) return fail(list)
          return list.value.flatMap(({ login, repositories, error }) => {
            const group = { name: login, label: login }
            if (error !== undefined) return [{ id: `${login}\n`, label: t('command.accountFailed', { error }), group }]
            return repositories.map((repo) => {
              const inUse = view !== null && view.account === login && view.repository === repo.fullName
              return { id: `${login}\n${repo.fullName}`, label: repo.fullName, group, active: inUse, ...inUse ? { detail: t('command.inUse') } : {} }
            })
          })
        },
        onSelect: async (option, session) => {
          const [account, repository] = option.id.split('\n')
          if (account === undefined || repository === undefined || repository === '') return
          const result = await selectFor(String(session.sessionId), repository, null, account)
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
          const result = await selectFor(sessionId, view.repository, option.id, view.account)
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
      return {
        hooks: { view: viewOf(sessionId), presetIds }, sessionId,
        load: async () => outcome(await api().environment(sessionId)),
        usage: async () => outcome(await api().usage(sessionId)),
        variables: async () => outcome(await api().sessionVariables(sessionId)),
        saveVariables: async (lines: string[]) => outcome(await api().setSessionVariables(sessionId, lines)),
        grants: async () => outcome(await api().networkGrants(sessionId)),
        revokeGrant: async (host: string) => outcome(await api().revokeNetworkGrant(sessionId, host)),
        overrides: async () => outcome(await api().sessionOverrides(sessionId)),
        saveOverrides: async (overrides: SessionOverrides) => outcome(await api().setSessionOverrides(sessionId, overrides)),
      }
    },
  }, EnvironmentTab as ComponentType<never>))

  face.slots.inject('conversation.view', () => face.slots.register({
    name: 'conversation.view', id: 'dsh-code.preview', order: 30, locale: NS,
    label: () => t('view.preview'),
    inject: (sessionId: string) => {
      watch(sessionId)
      return {
        hooks: { view: viewOf(sessionId), presetIds }, sessionId,
        targets: async () => outcome(await api().previewTargets(sessionId)),
        open: async (port: number) => outcome(await api().previewUrl(sessionId, port)),
        mode: async () => outcome(await api().sessionOverrides(sessionId)),
        frame: async (port: number, after: number) => outcome(await api().browserFrame(sessionId, port, after)),
        input: async (action: BrowserAction) => outcome(await api().browserInput(sessionId, action)),
        stop: async () => outcome(await api().browserStop(sessionId)),
      }
    },
  }, PreviewTab as ComponentType<never>))

  face.slots.inject('conversation.input.left', () => face.slots.register({
    name: 'conversation.input.left', id: 'dsh-code.selection', order: 10, locale: NS,
    inject: (sessionId: string) => {
      watch(sessionId)
      return { hooks: { view: viewOf(sessionId), presetIds }, sessionId }
    },
  }, SelectionLabel as ComponentType<never>))

  face.slots.inject('conversation.input.dock', () => face.slots.register({
    name: 'conversation.input.dock', id: 'dsh-code.setup', order: 15, locale: NS,
    inject: (sessionId: string) => {
      watch(sessionId)
      return {
        hooks: { presetIds }, sessionId,
        setup: async (again: boolean) => outcome(await api().setupStatus(again)),
        buildWorker: async () => outcome(await api().buildWorker()),
      }
    },
  }, SetupNotice as ComponentType<never>))

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
      pendingWork: async () => outcome(await api().pendingWork(sessionId)),
      // Delete removes the workspace, then the session: permanently through the session-delete plugin when
      // it is installed, otherwise by archiving it (the Harness's own removal; its history stays recoverable).
      remove: async () => {
        const result = outcome(await api().deleteWorkspace(sessionId))
        if (!result.ok) return result
        void refresh()
        const removal = await removeSession(sessionId)
        return removal === undefined ? result : { ok: false, message: removal } as const
      },
    }),
  }, SessionActions as ComponentType<never>))

  face.slots.inject('settings.section', () => face.slots.register({
    name: 'settings.section', id: 'dsh-code', order: 25, locale: NS,
    label: () => face.locale.bind(NS)('settings.nav'),
    inject: () => ({
      load: async () => outcome(await api().settings()),
      accounts: async () => outcome(await api().ghAccounts()),
      pickFolder: async () => {
        try {
          const ws = ctx.get('uiWorkspace' as never) as { pickDirectory?(): Promise<string | null> } | undefined
          return ws?.pickDirectory === undefined ? null : await ws.pickDirectory()
        } catch {
          // No picker in this Harness, or the context was replaced; the list stays editable by hand.
          return null
        }
      },
      save: async (settings: CodeSettings) => outcome(await api().updateSettings(settings)),
    }),
  }, CodeSettingsSection as ComponentType<never>))
}
