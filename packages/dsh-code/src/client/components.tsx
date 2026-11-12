/**
 * Code plugin slot components. Each one renders nothing outside its Code
 * context, so ordinary Chat sessions look exactly as they do without the
 * plugin. Copy comes from the `dsh-code` locale namespace.
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { BranchList, CodeSessionView, PendingWork, RepositorySummary, SelfTestReport } from '../types.ts'
import type { NS } from './locales.ts'

type T = PropsLocale<typeof NS>['t']

/** Result of one Remote call, reduced for the UI. */
export type Outcome<V> = { readonly ok: true; readonly value: V } | { readonly ok: false; readonly message: string }

const row: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
const select: CSSProperties = {
  font: 'inherit', fontSize: 13, padding: '4px 8px', borderRadius: 8, maxWidth: 260,
  border: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,.35))', background: 'transparent', color: 'inherit',
}
const note: CSSProperties = { fontSize: 12, opacity: 0.75, padding: '4px 2px' }

// ── Repository and branch pickers (conversation.hero.options) ──────────────

/** Injected face of the New Session pickers. */
export interface PickersInjected {
  readonly hooks: {
    readonly codeIds: HostObservable<ReadonlySet<string>>
    readonly presetIds: HostObservable<ReadonlySet<string>>
    readonly view: HostObservable<CodeSessionView | null>
  }
  readonly sessionId: string
  readonly setup: (refresh: boolean) => Promise<Outcome<SelfTestReport>>
  readonly repositories: () => Promise<Outcome<RepositorySummary[]>>
  readonly branches: (repository: string) => Promise<Outcome<BranchList>>
  readonly select: (repository: string, branch: string | null) => Promise<Outcome<CodeSessionView>>
}

/**
 * Repository and base-branch dropdowns, shown only on a Code mode session.
 * @param props - injected Remote calls, state and translator.
 * @returns the pickers, the setup report, or nothing on other sessions.
 */
export function RepositoryPickers({ useCodeIds, usePresetIds, useView, sessionId, setup, repositories, branches, select: choose, t }: InjectFace<PickersInjected> & PropsLocale<typeof NS>): ReactNode {
  const selected = useCodeIds(ids => ids.has(sessionId))
  const preset = usePresetIds(ids => ids.has(sessionId))
  const mode = selected || preset ? 'code' : 'chat'
  const view = useView(value => value)
  const [report, setReport] = useState<SelfTestReport | null>(null)
  const [repos, setRepos] = useState<RepositorySummary[] | null>(null)
  const [branchList, setBranchList] = useState<BranchList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [manual, setManual] = useState(false)
  const [typed, setTyped] = useState('')
  const [repository, setRepository] = useState<string>(view?.repository ?? '')
  const [branch, setBranch] = useState<string>(view?.baseBranch ?? '')
  // A choice made from the composer's + menu updates the view; the dropdowns follow it.
  useEffect(() => {
    if (view === null) return
    setRepository(view.repository)
    setBranch(view.baseBranch)
  }, [view?.repository, view?.baseBranch])

  useEffect(() => {
    if (mode !== 'code') return
    let live = true
    void setup(false).then((result) => {
      if (!live) return
      if (!result.ok) { setError(result.message); return }
      setReport(result.value)
      if (result.value.ok) {
        void repositories().then((list) => {
          if (!live) return
          if (list.ok) setRepos(list.value)
          else { setManual(true); setError(list.message) }
        })
      }
    })
    return () => { live = false }
  }, [mode, setup, repositories])

  useEffect(() => {
    if (repository === '') return
    let live = true
    setBranchList(null)
    void branches(repository).then((result) => {
      if (!live) return
      if (!result.ok) { setError(result.message); return }
      setBranchList(result.value)
      const chosen = branch !== '' && result.value.branches.includes(branch) ? branch : result.value.defaultBranch
      setBranch(chosen)
      void choose(repository, chosen).then(r => { if (!r.ok) setError(r.message) })
    })
    return () => { live = false }
    // Branch changes are submitted by the branch select itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repository, branches, choose])

  if (mode !== 'code') return null
  if (report !== null && !report.ok) {
    return (
      <div style={{ ...note, maxWidth: 420 }} role="alert">
        <strong>{t('setup.title')}</strong>
        <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
          {report.checks.filter(c => !c.ok).map(c => <li key={c.id}>{c.detail}</li>)}
        </ul>
        <Button size="sm" variant="outline" onClick={() => { void setup(true).then(r => { if (r.ok) setReport(r.value) }) }}>{t('setup.retry')}</Button>
      </div>
    )
  }
  const locked = view !== null && view.status !== 'pending'
  return (
    <div style={row}>
      {manual
        ? (
          <label style={row}>
            <span style={note}>{t('picker.repository')}</span>
            <Input
              aria-label={t('picker.repository')}
              placeholder={t('picker.manual')}
              value={typed}
              disabled={locked}
              onChange={(event) => { setTyped(event.target.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter') { setError(null); setRepository(typed.trim()) } }}
              onBlur={() => { if (typed.trim() !== '' && typed.trim() !== repository) { setError(null); setRepository(typed.trim()) } }}
            />
          </label>
        )
        : (
      <label style={row}>
        <span style={note}>{t('picker.repository')}</span>
        <select
          style={select}
          aria-label={t('picker.repository')}
          disabled={repos === null || locked}
          value={repository}
          onChange={(event) => { setRepository(event.target.value) }}
        >
          <option value="" disabled>{repos === null ? t('picker.loading') : t('picker.chooseRepository')}</option>
          {(repos ?? []).map(r => <option key={r.fullName} value={r.fullName}>{r.fullName}</option>)}
        </select>
      </label>
        )}
      <label style={row}>
        <span style={note}>{t('picker.branch')}</span>
        <select
          style={select}
          aria-label={t('picker.branch')}
          disabled={branchList === null || locked}
          value={branch}
          onChange={(event) => {
            setBranch(event.target.value)
            void choose(repository, event.target.value).then(r => { if (!r.ok) setError(r.message) })
          }}
        >
          {branchList === null && <option value="">{t('picker.loading')}</option>}
          {(branchList?.branches ?? []).map(b => (
            <option key={b} value={b}>{b === branchList?.defaultBranch ? t('picker.default', { branch: b }) : b}</option>
          ))}
        </select>
      </label>
      {error !== null && <span style={note} role="alert">{t('error.generic', { error })}</span>}
    </div>
  )
}

// ── Provisioning status (conversation.input.dock) ──────────────────────────

/** Injected face of the composer status line. */
export interface StatusInjected {
  readonly hooks: { readonly view: HostObservable<CodeSessionView | null> }
}

/**
 * One-line workspace status above the composer for Code sessions.
 * @param props - injected session view and translator.
 * @returns the status line, or nothing for other sessions.
 */
export function WorkspaceStatusLine({ useView, t }: InjectFace<StatusInjected> & PropsLocale<typeof NS>): ReactNode {
  const view = useView(value => value)
  if (view === null) return null
  const text = statusText(view, t)
  if (text === undefined) return null
  return <div style={note} role="status" aria-live="polite">{text}</div>
}

function statusText(view: CodeSessionView, t: T): string | undefined {
  switch (view.status) {
    case 'pending': return t('status.pending')
    case 'created':
    case 'provisioning': return t('status.provisioning')
    case 'restarting': return t('status.restarting')
    case 'ready': return t('status.ready', { branch: view.workingBranch ?? view.baseBranch })
    case 'offline': return t('status.offline')
    case 'failed': return t('status.failed', { error: view.error ?? '' })
    case 'deleting':
    case 'deleted': return undefined
    default: return undefined
  }
}

// ── Session actions (conversation.session.header.actions) ──────────────────

/** Injected face of the header actions. */
export interface ActionsInjected {
  readonly hooks: { readonly view: HostObservable<CodeSessionView | null> }
  readonly diff: () => Promise<Outcome<string>>
  readonly pendingWork: () => Promise<Outcome<PendingWork | null>>
  readonly createPullRequest: (title: string, body: string) => Promise<Outcome<string>>
  readonly restart: () => Promise<Outcome<CodeSessionView>>
  readonly remove: () => Promise<Outcome<void>>
}

type Dialog = { kind: 'diff'; text: string } | { kind: 'pr' } | { kind: 'delete'; pending: PendingWork | null } | { kind: 'message'; text: string }

/**
 * Diff, pull request, restart and delete actions for a Code session.
 * @param props - injected Remote calls, session view and translator.
 * @returns the action buttons and their dialogs, or nothing for other sessions.
 */
export function SessionActions({ useView, diff, pendingWork, createPullRequest, restart, remove, t }: InjectFace<ActionsInjected> & PropsLocale<typeof NS>): ReactNode {
  const view = useView(value => value)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const close = useMemo(() => () => { setDialog(null) }, [])
  if (view === null || view.status === 'pending' || view.status === 'deleted') return null
  const run = async <V,>(work: () => Promise<Outcome<V>>, done: (value: V) => Dialog | null): Promise<void> => {
    setBusy(true)
    const result = await work()
    setBusy(false)
    setDialog(result.ok ? done(result.value) : { kind: 'message', text: t('error.generic', { error: result.message }) })
  }
  const ready = view.status === 'ready'
  return (
    <div style={row}>
      <Button size="sm" disabled={!ready || busy} onClick={() => { void run(diff, text => ({ kind: 'diff', text })) }}>{t('action.diff')}</Button>
      <Button size="sm" disabled={!ready || busy} onClick={() => { setTitle(''); setBody(''); setDialog({ kind: 'pr' }) }}>{t('action.pr')}</Button>
      <Button size="sm" disabled={busy} onClick={() => { void run(restart, () => null) }}>{t('action.restart')}</Button>
      <Button size="sm" disabled={busy} onClick={() => { void run(pendingWork, pending => ({ kind: 'delete', pending })) }}>{t('action.delete')}</Button>
      <Modal open={dialog?.kind === 'diff'} onClose={close} closeLabel={t('action.close')} title={t('diff.title', { commit: (view.baseCommit ?? '').slice(0, 10) })}>
        <pre style={{ maxHeight: '60vh', overflow: 'auto', fontSize: 12, whiteSpace: 'pre' }}>
          {dialog?.kind === 'diff' ? (dialog.text === '' ? t('diff.empty') : dialog.text) : ''}
        </pre>
      </Modal>
      <Modal
        open={dialog?.kind === 'pr'}
        onClose={close}
        closeLabel={t('action.close')}
        title={t('pr.title')}
        footer={<Button variant="primary" disabled={busy || title.trim() === ''} onClick={() => { void run(() => createPullRequest(title.trim(), body), url => ({ kind: 'message', text: t('pr.done', { url }) })) }}>{t('pr.submit')}</Button>}
      >
        <div style={{ display: 'grid', gap: 8 }}>
          <Input aria-label={t('pr.fieldTitle')} placeholder={t('pr.fieldTitle')} value={title} onChange={(event) => { setTitle(event.target.value) }} />
          <textarea aria-label={t('pr.fieldBody')} placeholder={t('pr.fieldBody')} value={body} rows={6} style={{ ...select, maxWidth: 'none' }} onChange={(event) => { setBody(event.target.value) }} />
        </div>
      </Modal>
      <Modal
        open={dialog?.kind === 'delete'}
        onClose={close}
        closeLabel={t('action.close')}
        title={t('delete.title')}
        description={dialog?.kind === 'delete' && dialog.pending !== null && (dialog.pending.dirtyFiles > 0 || dialog.pending.unpushedCommits > 0)
          ? t('delete.warning', { files: String(dialog.pending.dirtyFiles), commits: String(dialog.pending.unpushedCommits) })
          : t('delete.clean')}
        footer={<Button variant="primary" disabled={busy} onClick={() => { void run(remove, () => null) }}>{t('delete.confirm')}</Button>}
      />
      <Modal open={dialog?.kind === 'message'} onClose={close} closeLabel={t('action.close')} title={t('dialog.title')} description={dialog?.kind === 'message' ? dialog.text : ''} />
    </div>
  )
}
