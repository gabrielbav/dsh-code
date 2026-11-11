/**
 * Code plugin, browser half. Adds the Chat | Code switch to the sidebar
 * (`sidebar.mode`), filters the session list by mode through
 * `uiWorkspace.registerSessionFilter`, shows repository and branch pickers on
 * a blank session in Code mode, a workspace status line above the composer,
 * and Diff / Create PR / Restart / Delete actions in a Code session header.
 *
 * `sidebar.mode` and `registerSessionFilter` come from the DeepSeek Harness
 * extension points added in gabrielbav/deepseek-harness. On a Harness
 * without them, the switch and the filter are absent and Code sessions are
 * started from the preset selector instead; everything else works.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import remote from '@gabrielbav/dsh-code/remote'
import type { CodeSessionView, RepositorySummary, BranchList, PendingWork, SelfTestReport, PushResult } from '../types.ts'
import { ModeSwitch, RepositoryPickers, SessionActions, WorkspaceStatusLine, type Outcome } from './components.tsx'
import { cell, readMode, sameIds, writeMode, type Cell, type CodeMode } from './store.ts'
import { en, NS, zh } from './locales.ts'

/** Preset id the bundle patch declares for Code sessions. */
const PRESET_ID = 'code'
const POLL_MS = 2000

type Result<V> = { readonly ok: true; readonly value: V } | { readonly ok: false; readonly error: { readonly message: string } }

/** The Remote namespace generated from the Host service. */
interface CodeRemote {
  setupStatus(refresh: boolean): Promise<Result<SelfTestReport>>
  homeWorkspace(): Promise<Result<string>>
  repositories(query: string | null): Promise<Result<RepositorySummary[]>>
  branches(repository: string): Promise<Result<BranchList>>
  select(sessionId: string, repository: string, baseBranch: string | null): Promise<Result<CodeSessionView>>
  sessions(): Promise<Result<CodeSessionView[]>>
  diff(sessionId: string): Promise<Result<string>>
  pendingWork(sessionId: string): Promise<Result<PendingWork | null>>
  commitAndPush(sessionId: string, message: string): Promise<Result<PushResult>>
  createPullRequest(sessionId: string, title: string, body: string): Promise<Result<string>>
  restart(sessionId: string): Promise<Result<CodeSessionView>>
  deleteWorkspace(sessionId: string): Promise<Result<void>>
}

/** Sidebar filter registration offered by the fork's ui-workspace. */
interface SessionListFilter {
  readonly id: string
  session(summary: { readonly id: string; readonly blank: boolean }): boolean
  workspace?(workspace: { readonly workspaceId: string; readonly sessionIds: readonly string[] }): boolean
  subscribe(listener: () => void): () => void
}

interface UiWorkspaceFace {
  startSession(workspaceId?: string, options?: { readonly agentPreset?: string }): void
  registerSessionFilter?(filter: SessionListFilter): () => void
}

/** The parts of the Client context this plugin uses. */
interface ClientFace {
  readonly slots: {
    inject(name: string, factory: () => () => void): void
    register(options: { readonly name: string; readonly id: string; readonly order?: number; readonly locale?: string; readonly inject?: (sessionId: string) => object }, component: ComponentType<never>): () => void
  }
  readonly locale: { register(ns: string, dicts: Record<string, Record<string, string>>): () => void }
  readonly remote: {
    $mount(contribution: unknown): Promise<() => Promise<void> | void>
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
  const api = (): CodeRemote => face.remote.codeWorkspaces

  const mode = cell<CodeMode>(readMode())
  const codeIds = cell<ReadonlySet<string>>(new Set(), sameIds)
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

  const uiWorkspace = (): UiWorkspaceFace | undefined => ctx.get('uiWorkspace' as never) as UiWorkspaceFace | undefined
  const home = cell<string | null>(null)
  const ensureHome = async (): Promise<string | undefined> => {
    const known = home.getSnapshot()
    if (known !== null) return known
    const result = await api().homeWorkspace().catch(() => undefined)
    if (result === undefined || !result.ok) return undefined
    home.set(result.value)
    return result.value
  }
  const choose = (next: CodeMode): void => {
    if (next === mode.getSnapshot()) return
    writeMode(next)
    mode.set(next)
    if (next === 'chat') {
      uiWorkspace()?.startSession(undefined, {})
      return
    }
    void ensureHome().then((workspaceId) => { uiWorkspace()?.startSession(workspaceId, { agentPreset: PRESET_ID }) })
  }
  if (mode.getSnapshot() === 'code') void ensureHome()

  ctx.inject(['uiWorkspace'], (scoped) => scoped.effect(() => {
    const ws = scoped.get('uiWorkspace' as never) as UiWorkspaceFace | undefined
    if (ws?.registerSessionFilter === undefined) return () => {}
    const subscribers = new Set<() => void>()
    const notify = (): void => { for (const listener of [...subscribers]) listener() }
    const offMode = mode.subscribe(notify)
    const offIds = codeIds.subscribe(notify)
    const offHome = home.subscribe(notify)
    const dispose = ws.registerSessionFilter({
      id: 'dsh-code.mode',
      session: (summary) => {
        if (summary.blank) return true
        const isCode = codeIds.getSnapshot().has(String(summary.id))
        return mode.getSnapshot() === 'code' ? isCode : !isCode
      },
      workspace: (workspace) => {
        const isHome = String(workspace.workspaceId) === home.getSnapshot()
        if (mode.getSnapshot() === 'chat') return !isHome
        const ids = codeIds.getSnapshot()
        return isHome || workspace.sessionIds.some(id => ids.has(String(id)))
      },
      subscribe: (listener) => {
        subscribers.add(listener)
        return () => { subscribers.delete(listener) }
      },
    })
    return () => { dispose(); offMode(); offIds(); offHome() }
  }, 'dsh-code: session list filter'))

  face.slots.inject('sidebar.mode', () => face.slots.register({
    name: 'sidebar.mode', id: 'dsh-code.mode', locale: NS,
    inject: () => ({ hooks: { mode }, choose }),
  }, ModeSwitch as ComponentType<never>))

  face.slots.inject('conversation.hero.options', () => face.slots.register({
    name: 'conversation.hero.options', id: 'dsh-code.repository', order: 10, locale: NS,
    inject: (sessionId: string) => ({
      hooks: { mode, view: viewOf(sessionId) },
      setup: async (again: boolean) => outcome(await api().setupStatus(again)),
      repositories: async () => outcome(await api().repositories(null)),
      branches: async (repository: string) => outcome(await api().branches(repository)),
      select: async (repository: string, branch: string | null) => {
        const presets = ctx.get('remote.agentPresets' as never) as { select(sessionId: string, presetId: string): Promise<Result<string>> } | undefined
        const preset = await presets?.select(sessionId, PRESET_ID)
        if (preset !== undefined && !preset.ok) return { ok: false, message: preset.error.message } as const
        const result = outcome(await api().select(sessionId, repository, branch))
        if (result.ok) {
          viewOf(sessionId).set(result.value)
          codeIds.set(new Set([...codeIds.getSnapshot(), sessionId]))
        }
        return result
      },
    }),
  }, RepositoryPickers as ComponentType<never>))

  face.slots.inject('conversation.input.dock', () => face.slots.register({
    name: 'conversation.input.dock', id: 'dsh-code.status', order: 20, locale: NS,
    inject: (sessionId: string) => ({ hooks: { view: viewOf(sessionId) } }),
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
