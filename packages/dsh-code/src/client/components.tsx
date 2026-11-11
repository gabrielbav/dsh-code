/**
 * Code plugin slot components. Each one renders nothing outside its Code
 * context, so ordinary Chat sessions look exactly as they do without the
 * plugin. Copy comes from the `dsh-code` locale namespace.
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Button, Input, Modal, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CodeSessionView, CodeSettings, CodeSettingsView, PendingWork, SelfTestReport, SessionEnvironment, WorkspaceUsage } from '../types.ts'
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

// ── Guided setup (conversation.input.dock) ─────────────────────────────────

/** Injected face of the setup notice. */
export interface SetupInjected {
  readonly hooks: { readonly presetIds: HostObservable<ReadonlySet<string>> }
  readonly sessionId: string
  readonly setup: (refresh: boolean) => Promise<Outcome<SelfTestReport>>
  readonly buildWorker: () => Promise<Outcome<SelfTestReport>>
}

/**
 * Failing Docker + gVisor checks above the composer of a Code mode session, with each check's remedy,
 * Check again, and Build worker image when the image is missing. Renders nothing once every check passes.
 * @param props - injected setup calls, state and translator.
 * @returns the notice, or nothing.
 */
export function SetupNotice({ usePresetIds, sessionId, setup, buildWorker, t }: InjectFace<SetupInjected> & PropsLocale<typeof NS>): ReactNode {
  const codeMode = usePresetIds(ids => ids.has(sessionId))
  const [report, setReport] = useState<SelfTestReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [building, setBuilding] = useState(false)
  useEffect(() => {
    if (!codeMode) return
    let live = true
    void setup(false).then((result) => {
      if (!live) return
      if (result.ok) setReport(result.value)
      else setError(result.message)
    })
    return () => { live = false }
  }, [codeMode, setup])
  if (!codeMode || report === null || report.ok) return null
  return (
    <div style={{ ...note, maxWidth: 520 }} role="alert">
      <strong>{t('setup.title')}</strong>
      <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
        {report.checks.filter(c => !c.ok).map(c => (
          <li key={c.id}>{c.detail}{c.remedy !== undefined && <div style={{ opacity: 0.85 }}>{c.remedy}</div>}</li>
        ))}
      </ul>
      {building && <div>{t('setup.building')}</div>}
      {error !== null && <div role="alert">{t('error.generic', { error })}</div>}
      <div style={row}>
        <Button size="sm" variant="outline" disabled={building} onClick={() => { void setup(true).then(r => { if (r.ok) setReport(r.value) }) }}>{t('setup.retry')}</Button>
        {report.checks.some(c => !c.ok && c.action === 'build-worker') && (
          <Button
            size="sm"
            disabled={building}
            onClick={() => {
              setBuilding(true)
              setError(null)
              void buildWorker().then((r) => {
                setBuilding(false)
                if (r.ok) setReport(r.value)
                else setError(r.message)
              })
            }}
          >
            {t('setup.build')}
          </Button>
        )}
      </div>
    </div>
  )
}

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
  if (view === null) return null
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
    // A ready workspace needs no line; the header actions show it is a Code session.
    case 'ready': return undefined
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
  readonly usage: () => Promise<Outcome<WorkspaceUsage | null>>
  readonly previewPorts: () => Promise<Outcome<readonly number[]>>
  readonly preview: (port: number) => Promise<Outcome<string>>
}

type Dialog =
  | { kind: 'diff'; text: string } | { kind: 'pr' } | { kind: 'delete'; pending: PendingWork | null } | { kind: 'message'; text: string }
  | { kind: 'resources' } | { kind: 'preview'; ports: readonly number[] }

/**
 * Format a byte count.
 * @param bytes - byte count.
 * @returns a short human-readable size.
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/** Live resource figures, polled while the dialog is open. */
function ResourcesBody({ usage, t }: { readonly usage: () => Promise<Outcome<WorkspaceUsage | null>>; readonly t: T }): ReactNode {
  const [value, setValue] = useState<WorkspaceUsage | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    const tick = (): void => { void usage().then((r) => { if (live) setValue(r.ok ? r.value : null) }) }
    tick()
    const timer = setInterval(tick, 2000)
    return () => { live = false; clearInterval(timer) }
  }, [usage])
  if (value === undefined) return <div style={note}>{t('picker.loading')}</div>
  if (value === null) return <div style={note}>{t('resources.unavailable')}</div>
  const rows: Array<[string, string]> = [
    [t('resources.cpu'), `${value.cpuPercent.toFixed(1)}%`],
    [t('resources.memory'), `${formatBytes(value.memoryBytes)} / ${formatBytes(value.memoryLimitBytes)}`],
    [t('resources.pids'), `${value.pids} / ${value.pidsLimit}`],
    [t('resources.disk'), formatBytes(value.diskBytes)],
  ]
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px', margin: 0, fontSize: 13 }}>
      {rows.map(([label, text]) => [<dt key={`${label}-k`} style={{ opacity: 0.75 }}>{label}</dt>, <dd key={`${label}-v`} style={{ margin: 0 }}>{text}</dd>])}
    </dl>
  )
}

/**
 * Diff, pull request, restart and delete actions for a Code session.
 * @param props - injected Remote calls, session view and translator.
 * @returns the action buttons and their dialogs, or nothing for other sessions.
 */
export function SessionActions({ useView, diff, pendingWork, createPullRequest, restart, remove, usage, previewPorts, preview, t }: InjectFace<ActionsInjected> & PropsLocale<typeof NS>): ReactNode {
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
      <Button size="sm" disabled={!ready || busy} onClick={() => { setDialog({ kind: 'resources' }) }}>{t('action.resources')}</Button>
      <Button size="sm" disabled={!ready || busy} onClick={() => { void run(previewPorts, ports => ({ kind: 'preview', ports })) }}>{t('action.preview')}</Button>
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
      <Modal open={dialog?.kind === 'resources'} onClose={close} closeLabel={t('action.close')} title={t('resources.title')}>
        {dialog?.kind === 'resources' && <ResourcesBody usage={usage} t={t} />}
      </Modal>
      <Modal open={dialog?.kind === 'preview'} onClose={close} closeLabel={t('action.close')} title={t('preview.title')} description={t('preview.note')}>
        {dialog?.kind === 'preview' && (dialog.ports.length === 0
          ? <div style={note}>{t('preview.none')}</div>
          : (
            <div style={row}>
              {dialog.ports.map(port => (
                <Button
                  key={port}
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    // Open synchronously so the browser does not block the tab, then navigate it.
                    const tab = window.open('about:blank', '_blank')
                    void preview(port).then((r) => {
                      if (r.ok && tab !== null) { tab.opener = null; tab.location.href = r.value }
                      else { tab?.close(); setDialog({ kind: 'message', text: r.ok ? r.value : t('error.generic', { error: r.message }) }) }
                    })
                  }}
                >
                  {`${t('preview.open')} :${port}`}
                </Button>
              ))}
            </div>
          ))}
      </Modal>
      <Modal open={dialog?.kind === 'message'} onClose={close} closeLabel={t('action.close')} title={t('dialog.title')} description={dialog?.kind === 'message' ? dialog.text : ''} />
    </div>
  )
}

// ── Environment tab (conversation.view) ────────────────────────────────────

/** Injected face of the Environment tab. */
export interface EnvironmentInjected {
  readonly hooks: { readonly view: HostObservable<CodeSessionView | null>; readonly presetIds: HostObservable<ReadonlySet<string>> }
  readonly load: () => Promise<Outcome<SessionEnvironment>>
}

const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', fontSize: 13, margin: 0 }
const term: CSSProperties = { opacity: 0.65 }
const value: CSSProperties = { margin: 0, fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', overflowWrap: 'anywhere' }

/**
 * Where this session runs: on this computer, or in an isolated Code workspace with its account, repository,
 * branches and container. Reloads when the session's Code state changes.
 * @param props - injected loader, state and translator.
 * @returns the environment details.
 */
export function EnvironmentView({ useView, usePresetIds, load, t }: InjectFace<EnvironmentInjected> & PropsLocale<typeof NS>): ReactNode {
  const view = useView(v => v)
  const presets = usePresetIds(ids => ids.size)
  const [env, setEnv] = useState<SessionEnvironment | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void load().then((result) => {
      if (!live) return
      if (result.ok) { setEnv(result.value); setError(null) } else setError(result.message)
    })
    return () => { live = false }
  }, [load, view?.status, view?.repository, view?.baseBranch, view?.account, presets])
  if (error !== null) return <div style={{ ...note, padding: 16 }} role="alert">{t('error.generic', { error })}</div>
  if (env === null) return <div style={{ ...note, padding: 16 }}>{t('picker.loading')}</div>
  const rows: [string, string | undefined][] = env.mode === 'host'
    ? [[t('env.runs'), t('env.host')], [t('env.directory'), env.workingDirectory]]
    : [
      [t('env.runs'), t('env.code')],
      [t('env.account'), env.account],
      [t('env.repository'), env.repository ?? t('env.notChosen')],
      [t('env.baseBranch'), env.baseBranch],
      [t('env.baseCommit'), env.baseCommit?.slice(0, 12)],
      [t('env.workingBranch'), env.workingBranch],
      [t('env.status'), env.status],
      [t('env.directory'), env.workingDirectory],
      [t('env.container'), env.container?.name],
      [t('env.runtime'), env.container === undefined ? undefined : `${env.container.runtime} (gVisor)`],
      [t('env.image'), env.container?.image],
      [t('env.network'), env.container === undefined ? undefined : t('env.networkValue', { mode: env.container.network })],
      [t('env.limits'), env.container === undefined ? undefined : t('env.limitsValue', { cpus: String(env.container.cpus), memory: String(env.container.memoryMb) })],
    ]
  return (
    <div style={{ padding: 16, maxWidth: 760 }}>
      <dl style={grid}>
        {rows.filter((row): row is [string, string] => row[1] !== undefined && row[1] !== '').map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt style={term}>{k}</dt>
            <dd style={value}>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

// ── Settings > Code (settings.section) ──────────────────────────────────────

/** Injected face of the settings page. */
export interface SettingsInjected {
  readonly load: () => Promise<Outcome<CodeSettingsView>>
  readonly save: (settings: CodeSettings) => Promise<Outcome<CodeSettingsView>>
}

type Draft = Record<'allow' | 'privateAllow' | 'ports' | 'previewPorts' | 'cpus' | 'memoryMb' | 'pids' | 'tmpMb' | 'maxWorkspaces' | 'workerImage', string> & { network: CodeSettings['network'] }

function toDraft(settings: CodeSettings): Draft {
  return {
    network: settings.network,
    allow: settings.allow.join('\n'), privateAllow: settings.privateAllow.join('\n'),
    ports: settings.ports.join(', '), previewPorts: settings.previewPorts.join(', '),
    cpus: String(settings.cpus), memoryMb: String(settings.memoryMb), pids: String(settings.pids), tmpMb: String(settings.tmpMb),
    maxWorkspaces: String(settings.maxWorkspaces), workerImage: settings.workerImage,
  }
}

/**
 * Parse the form back into settings; the host validates again.
 * @param draft - form state.
 * @returns settings.
 */
export function fromDraft(draft: Draft): CodeSettings {
  const lines = (text: string): string[] => text.split(/[\n,]/).map(x => x.trim()).filter(x => x !== '')
  const numbers = (text: string): number[] => lines(text).map(Number)
  return {
    network: draft.network, allow: lines(draft.allow), privateAllow: lines(draft.privateAllow),
    ports: numbers(draft.ports), previewPorts: numbers(draft.previewPorts),
    cpus: Number(draft.cpus), memoryMb: Number(draft.memoryMb), pids: Number(draft.pids), tmpMb: Number(draft.tmpMb),
    maxWorkspaces: Number(draft.maxWorkspaces), workerImage: draft.workerImage.trim(),
  }
}

/**
 * Settings > Code: network policy, resource limits, worker image and preview ports.
 * @param props - injected load/save and translator.
 * @returns the settings page.
 */
export function CodeSettingsSection({ load, save, t }: SettingsInjected & PropsLocale<typeof NS>): ReactNode {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [writable, setWritable] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void load().then((r) => {
      if (!live) return
      if (r.ok) { setDraft(toDraft(r.value.settings)); setWritable(r.value.writable) }
      else setMessage(t('error.generic', { error: r.message }))
    })
    return () => { live = false }
  }, [load, t])
  if (draft === null) return <div style={note}>{message ?? t('picker.loading')}</div>
  const field = (key: Exclude<keyof Draft, 'network' | 'allow' | 'privateAllow'>, type: 'text' | 'number' = 'text'): ReactNode => (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={note}>{t(`settings.${key}`)}</span>
      <Input aria-label={t(`settings.${key}`)} type={type} value={draft[key]} onChange={(event) => { setDraft({ ...draft, [key]: event.target.value }) }} />
    </label>
  )
  const area = (key: 'allow' | 'privateAllow'): ReactNode => (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={note}>{t(`settings.${key}`)}</span>
      <textarea aria-label={t(`settings.${key}`)} rows={6} value={draft[key]} style={{ ...select, maxWidth: 'none', fontFamily: 'monospace' }} onChange={(event) => { setDraft({ ...draft, [key]: event.target.value }) }} />
    </label>
  )
  return (
    <form
      style={{ display: 'grid', gap: 16, maxWidth: 640 }}
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        setMessage(null)
        void save(fromDraft(draft)).then((r) => {
          setBusy(false)
          if (r.ok) { setDraft(toDraft(r.value.settings)); setWritable(r.value.writable); setMessage(t('settings.saved')) }
          else setMessage(t('error.generic', { error: r.message }))
        })
      }}
    >
      <h2 style={{ margin: 0, fontSize: 16 }}>{t('settings.title')}</h2>
      {!writable && <div style={note} role="note">{t('settings.notWritable')}</div>}
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }}>
        <legend style={{ fontWeight: 600, marginBottom: 4 }}>{t('settings.network')}</legend>
        <SegmentedControl<CodeSettings['network']>
          id="dsh-code-network"
          label={t('settings.network')}
          value={draft.network}
          onChange={(network) => { setDraft({ ...draft, network }) }}
          options={[
            { value: 'allowlist', label: t('settings.network.allowlist') },
            { value: 'none', label: t('settings.network.none') },
            { value: 'open', label: t('settings.network.open') },
          ]}
        />
        {draft.network === 'open' && <div style={note} role="alert">{t('settings.network.openWarning')}</div>}
        {area('allow')}
        {area('privateAllow')}
        {field('ports')}
      </fieldset>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <legend style={{ fontWeight: 600, marginBottom: 4 }}>{t('settings.limits')}</legend>
        {field('cpus', 'number')}
        {field('memoryMb', 'number')}
        {field('pids', 'number')}
        {field('tmpMb', 'number')}
        {field('maxWorkspaces', 'number')}
      </fieldset>
      {field('workerImage')}
      {field('previewPorts')}
      <div style={row}>
        <Button type="submit" variant="primary" disabled={busy}>{t('settings.save')}</Button>
        {message !== null && <span style={note} role="status" aria-live="polite">{message}</span>}
      </div>
    </form>
  )
}
