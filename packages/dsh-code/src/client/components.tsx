/**
 * Code plugin slot components. Each one renders nothing outside its Code
 * context, so ordinary Chat sessions look exactly as they do without the
 * plugin. Copy comes from the `dsh-code` locale namespace.
 */
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CodeSessionView, PendingWork } from '../types.ts'
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

// ── Provisioning status (conversation.input.dock) ──────────────────────────

/** Injected face of the composer status line. */
export interface StatusInjected {
  readonly hooks: { readonly view: HostObservable<CodeSessionView | null>; readonly presetIds: HostObservable<ReadonlySet<string>> }
  readonly sessionId: string
}

/**
 * One-line workspace status above the composer for Code sessions.
 * @param props - injected session view and translator.
 * @returns the status line, or nothing for other sessions.
 */
export function WorkspaceStatusLine({ useView, usePresetIds, sessionId, t }: InjectFace<StatusInjected> & PropsLocale<typeof NS>): ReactNode {
  const view = useView(value => value)
  const codeMode = usePresetIds(ids => ids.has(sessionId))
  if (view === null) return codeMode ? <div style={note} role="status" aria-live="polite">{t('status.choose')}</div> : null
  if (view.status === 'pending' && !codeMode) return null
  const text = statusText(view, t)
  if (text === undefined) return null
  return <div style={note} role="status" aria-live="polite">{text}</div>
}

function statusText(view: CodeSessionView, t: T): string | undefined {
  switch (view.status) {
    case 'pending': return t('status.pending', { repository: view.repository, branch: view.baseBranch })
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
