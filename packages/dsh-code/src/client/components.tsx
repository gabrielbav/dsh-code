/**
 * Code plugin slot components. Each one renders nothing outside its Code
 * context, so ordinary Chat sessions look exactly as they do without the
 * plugin. Copy comes from the `dsh-code` locale namespace.
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Button, Input, Modal, SegmentedControl, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserAction, CodeSessionView, CodeSettings, CodeSettingsView, GhAccount, IsolatedFrame, PreviewTargets, ProvisionStep, SessionOverrides, SessionOverridesView, SessionVariables, PendingWork, SelfTestReport, SessionEnvironment, WorkspaceUsage } from '../types.ts'
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
  // The choice itself is shown beside the + button (SelectionLabel).
  if (view.status === 'pending') return null
  const text = statusText(view, t)
  if (text === undefined) return null
  return <div style={note} role="status" aria-live="polite">{text}</div>
}

function statusText(view: CodeSessionView, t: T): string | undefined {
  switch (view.status) {
    case 'pending': return undefined
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
  readonly pendingWork: () => Promise<Outcome<PendingWork | null>>
  readonly remove: () => Promise<Outcome<void>>

}

type Dialog =
  | { kind: 'delete'; pending: PendingWork | null } | { kind: 'message'; text: string }


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
 * The Delete session action for a Code session.
 * @param props - injected Remote calls, session view and translator.
 * @returns the action buttons and their dialogs, or nothing for other sessions.
 */
export function SessionActions({ useView, pendingWork, remove, t }: InjectFace<ActionsInjected> & PropsLocale<typeof NS>): ReactNode {
  const view = useView(value => value)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [busy, setBusy] = useState(false)
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
      <Button size="sm" disabled={busy} onClick={() => { void run(pendingWork, pending => ({ kind: 'delete', pending })) }}>{t('action.delete')}</Button>
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

// ── Environment (header dialog) ─────────────────────────────────────────────

const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', fontSize: 13, margin: 0 }
const term: CSSProperties = { opacity: 0.65 }
const value: CSSProperties = { margin: 0, fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', overflowWrap: 'anywhere' }

/**
 * Where this Code session runs: account, repository, branches, container, network and limits, then the
 * provisioning timeline. Reloads every second while the workspace is still starting.
 * @param props - environment loader, current workspace status and translator.
 * @returns the details.
 */
function EnvironmentPanel({ load, status, side, t }: { readonly load: () => Promise<Outcome<SessionEnvironment>>; readonly status: string; readonly side?: ReactNode; readonly t: T }): ReactNode {
  const [env, setEnv] = useState<SessionEnvironment | null>(null)
  const [error, setError] = useState<string | null>(null)
  const settling = env === null || (env.steps !== undefined && env.steps.length > 0 && !['ready', 'failed'].includes(env.steps[env.steps.length - 1]!.step))
  useEffect(() => {
    let live = true
    const tick = (): void => {
      void load().then((result) => {
        if (!live) return
        if (result.ok) { setEnv(result.value); setError(null) } else setError(result.message)
      })
    }
    tick()
    if (!settling) return () => { live = false }
    const timer = setInterval(tick, 1000)
    return () => { live = false; clearInterval(timer) }
  }, [load, status, settling])
  if (error !== null) return <div style={note} role="alert">{t('error.generic', { error })}</div>
  if (env === null) return <div style={note}>{t('picker.loading')}</div>
  const options = env.options
  const sandbox = options === undefined ? undefined : [
    `${t('env.lockdown')}: ${options.lockdown ? t('env.on') : t('env.off')}`,
    `${t('env.readOnlyWorkspace')}: ${options.readOnlyWorkspace ? t('env.on') : t('env.off')}`,
    `${t('env.dependencyCache')}: ${options.dependencyCache ? t('env.on') : t('env.off')}`,
    ...options.readOnlyFolders.length === 0 ? [] : [t('env.foldersCount', { count: String(options.readOnlyFolders.length) })],
  ].join(' · ')
  const rows: [string, string | undefined][] = env.mode === 'host'
    ? [[t('env.runs'), t('env.host')], [t('env.directory'), env.workingDirectory]]
    : [
      [t('env.runs'), t('env.code')],
      [t('env.account'), env.account],
      [t('env.repository'), env.repository],
      [t('env.baseBranch'), env.baseBranch],
      [t('env.baseCommit'), env.baseCommit?.slice(0, 12)],
      [t('env.workingBranch'), env.workingBranch],
      [t('env.status'), env.status],
      [t('env.network'), env.network === undefined ? undefined : t('env.networkValue', { mode: env.network })],
      [t('env.sandbox'), sandbox],
    ]
  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 24, alignItems: 'start' }}>
      <dl style={grid}>
        {rows.filter((row): row is [string, string] => row[1] !== undefined && row[1] !== '').map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt style={term}>{k}</dt>
            <dd style={value}>{v}</dd>
          </div>
        ))}
      </dl>
      {side}
      </div>
      {env.steps !== undefined && env.steps.length > 0 && <ProvisionSteps steps={env.steps} t={t} />}
    </div>
  )
}

const STEP_COLORS: Record<string, string> = {
  held: '#8e8e93', 'checking-runtime': '#5b8def', 'egress-proxy': '#9b7be0', 'resolving-revision': '#e0a23c',
  cloning: '#4caf7d', 'starting-container': '#e07a3c', 'health-check': '#3cb3c4', 'working-directory': '#b0b0b8',
  ready: '#4caf7d', failed: '#d9534f',
}

/**
 * The latest provisioning as a timeline: an overview bar with one span per step, then one row per step with
 * its label, duration and its span on the same time scale. Steps run one after another, so spans do not overlap.
 * @param props - recorded steps and translator.
 * @returns the timeline.
 */
function ProvisionSteps({ steps, t }: { readonly steps: readonly ProvisionStep[]; readonly t: T }): ReactNode {
  const start = steps[0]!.time
  const lastStep = steps[steps.length - 1]!
  const done = lastStep.step === 'ready' || lastStep.step === 'failed'
  const end = Math.max(done ? lastStep.time : Date.now(), start + 1)
  const total = end - start
  const spans = steps.map((s, i) => {
    const next = steps[i + 1]
    const until = next?.time ?? (done ? s.time : end)
    return { ...s, offset: s.time - start, duration: Math.max(until - s.time, 0), open: next === undefined && !done }
  })
  const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`
  const label = (step: string): string => {
    const key = `step.${step}` as never
    const text = t(key)
    return text === `step.${step}` ? step : text
  }
  const pct = (ms: number): string => `${(ms / total) * 100}%`
  const bar = (s: typeof spans[number], height: number): ReactNode => (
    <div
      key={`${s.step}-${s.time}`}
      title={`${label(s.step)} · ${seconds(s.duration)}`}
      style={{ position: 'absolute', left: pct(s.offset), width: `max(${pct(s.duration)}, 2px)`, top: 0, height, borderRadius: 2, background: STEP_COLORS[s.step] ?? '#8e8e93', opacity: s.open ? 0.6 : 1 }}
    />
  )
  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{t('env.steps', { when: new Date(start).toLocaleString() })}</h3>
        <span style={{ ...term, fontSize: 12 }}>{done ? t('step.total', { total: seconds(total) }) : t('step.running')}</span>
      </div>
      <div style={{ position: 'relative', height: 10, marginBottom: 10, background: 'var(--dsw-alias-bg-subtle, rgba(127,127,127,.12))', borderRadius: 2 }}>
        {spans.map(s => bar(s, 10))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 2fr) 56px 3fr', gap: '6px 12px', alignItems: 'center', fontSize: 12 }}>
        {spans.map(s => (
          <div key={`${s.step}-${s.time}`} style={{ display: 'contents' }}>
            <span style={s.step === 'failed' ? { color: '#d9534f' } : undefined}>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, marginRight: 6, background: STEP_COLORS[s.step] ?? '#8e8e93' }} />
              {label(s.step)}
              {s.error !== undefined && <div style={{ ...value, fontSize: 11, marginLeft: 14 }}>{s.error}</div>}
            </span>
            <span style={{ ...term, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{s.open ? '…' : seconds(s.duration)}</span>
            <div style={{ position: 'relative', height: 8 }}>{bar(s, 8)}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Settings > Code (settings.section) ──────────────────────────────────────

/** Injected face of the settings page. */
export interface SettingsInjected {
  readonly load: () => Promise<Outcome<CodeSettingsView>>
  readonly accounts: () => Promise<Outcome<GhAccount[]>>
  /** The Harness folder picker (in-app browser on the web, native dialog on desktop); null when cancelled or unavailable. */
  readonly pickFolder?: () => Promise<string | null>
  readonly save: (settings: CodeSettings) => Promise<Outcome<CodeSettingsView>>
}

type Draft = Record<'allow' | 'privateAllow' | 'ports' | 'previewPorts' | 'cpus' | 'memoryMb' | 'pids' | 'tmpMb' | 'maxWorkspaces' | 'workerImage' | 'shmMb' | 'readOnlyFolders' | 'environment', string>
  & { network: CodeSettings['network']; disabledAccounts: readonly string[]; newBranch: boolean; readOnlyWorkspace: boolean; dependencyCache: boolean; lockdown: boolean; previewEnabled: boolean; isolatedBrowser: boolean }

function toDraft(settings: CodeSettings): Draft {
  return {
    network: settings.network,
    allow: settings.allow.join('\n'), privateAllow: settings.privateAllow.join('\n'),
    ports: settings.ports.join(', '), previewPorts: settings.previewPorts.join(', '),
    cpus: String(settings.cpus), memoryMb: String(settings.memoryMb), pids: String(settings.pids), tmpMb: String(settings.tmpMb),
    maxWorkspaces: String(settings.maxWorkspaces), workerImage: settings.workerImage,
    disabledAccounts: settings.disabledAccounts, newBranch: settings.newBranch,
    shmMb: String(settings.shmMb), readOnlyFolders: settings.readOnlyFolders.join('\n'), environment: settings.environment.join('\n'),
    readOnlyWorkspace: settings.readOnlyWorkspace, dependencyCache: settings.dependencyCache, lockdown: settings.lockdown,
    previewEnabled: settings.previewEnabled, isolatedBrowser: settings.isolatedBrowser,
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
    disabledAccounts: draft.disabledAccounts, newBranch: draft.newBranch,
    shmMb: Number(draft.shmMb), readOnlyFolders: draft.readOnlyFolders.split('\n').map(x => x.trim()).filter(x => x !== ''),
    environment: draft.environment.split('\n').map(x => x.trim()).filter(x => x !== ''),
    readOnlyWorkspace: draft.readOnlyWorkspace, dependencyCache: draft.dependencyCache, lockdown: draft.lockdown,
    previewEnabled: draft.previewEnabled, isolatedBrowser: draft.isolatedBrowser,
  }
}

/**
 * Settings > Code: network policy, resource limits, worker image and preview ports.
 * @param props - injected load/save and translator.
 * @returns the settings page.
 */
export function CodeSettingsSection({ load, save, accounts, pickFolder, t }: SettingsInjected & PropsLocale<typeof NS>): ReactNode {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [logins, setLogins] = useState<GhAccount[] | null>(null)
  const [accountsError, setAccountsError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void accounts().then((r) => {
      if (!live) return
      if (r.ok) setLogins(r.value)
      else setAccountsError(r.message)
    })
    return () => { live = false }
  }, [accounts])
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
  const field = (key: Exclude<keyof Draft, 'network' | 'allow' | 'privateAllow' | 'disabledAccounts' | 'newBranch' | 'readOnlyWorkspace' | 'dependencyCache' | 'lockdown' | 'previewEnabled' | 'isolatedBrowser' | 'readOnlyFolders' | 'environment'>, type: 'text' | 'number' = 'text'): ReactNode => (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={note}>{t(`settings.${key}`)}</span>
      <Input aria-label={t(`settings.${key}`)} type={type} value={draft[key]} onChange={(event) => { setDraft({ ...draft, [key]: event.target.value }) }} />
    </label>
  )
  const toggle = (key: 'readOnlyWorkspace' | 'dependencyCache' | 'lockdown' | 'previewEnabled' | 'isolatedBrowser', hint: string): ReactNode => (
    <div style={{ display: 'grid', gap: 2, maxWidth: 560 }}>
      <div style={{ ...row, justifyContent: 'space-between' }}>
        <span>{t(`settings.${key}`)}</span>
        <Switch label={t(`settings.${key}`)} checked={draft[key]} onChange={(on) => { setDraft({ ...draft, [key]: on }) }} />
      </div>
      <div style={note}>{hint}</div>
    </div>
  )
  const area = (key: 'allow' | 'privateAllow' | 'readOnlyFolders' | 'environment'): ReactNode => (
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
      {toggle('lockdown', t('settings.lockdownHint'))}
      {draft.lockdown && <div style={note} role="note">{t('settings.lockdownActive')}</div>}
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
        {field('shmMb', 'number')}
      </fieldset>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 10 }} disabled={draft.lockdown}>
        <legend style={{ fontWeight: 600, marginBottom: 4 }}>{t('settings.workspace')}</legend>
        {toggle('readOnlyWorkspace', t('settings.readOnlyWorkspaceHint'))}
        {toggle('dependencyCache', t('settings.dependencyCacheHint'))}
        {area('readOnlyFolders')}
        {pickFolder !== undefined && (
          <div style={row}>
            <Button
              size="sm"
              variant="outline"
              type="button"
              onClick={() => {
                void pickFolder().then((folder) => {
                  if (folder === null || folder === '') return
                  const current = draft.readOnlyFolders.split('\n').map(x => x.trim()).filter(x => x !== '')
                  if (!current.includes(folder)) setDraft({ ...draft, readOnlyFolders: [...current, folder].join('\n') })
                })
              }}
            >
              {t('settings.addFolder')}
            </Button>
          </div>
        )}
        <div style={note} role="note">{t('settings.readOnlyFoldersHint')}</div>
      </fieldset>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 6 }}>
        <legend style={{ fontWeight: 600, marginBottom: 4 }}>{t('settings.variables')}</legend>
        {area('environment')}
        <div style={note}>{t('settings.environmentHint')}</div>
      </fieldset>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }}>
        <legend style={{ fontWeight: 600, marginBottom: 4 }}>{t('settings.accounts')}</legend>
        <div style={note}>{t('settings.accountsHint')}</div>
        {accountsError !== null && <div style={note} role="alert">{t('error.generic', { error: accountsError })}</div>}
        {logins === null && accountsError === null && <div style={note}>{t('picker.loading')}</div>}
        {logins?.length === 0 && <div style={note}>{t('settings.noAccounts')}</div>}
        {logins?.map(({ login }) => (
          <div key={login} style={{ ...row, justifyContent: 'space-between', maxWidth: 420 }}>
            <span>{login}</span>
            <Switch
              label={t('settings.accountToggle', { login })}
              checked={!draft.disabledAccounts.includes(login)}
              onChange={(on) => {
                const rest = draft.disabledAccounts.filter(l => l !== login)
                setDraft({ ...draft, disabledAccounts: on ? rest : [...rest, login] })
              }}
            />
          </div>
        ))}
      </fieldset>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }}>
        <legend style={{ fontWeight: 600, marginBottom: 4 }}>{t('settings.branches')}</legend>
        <div style={{ ...row, justifyContent: 'space-between', maxWidth: 420 }}>
          <span>{t('settings.newBranch')}</span>
          <Switch label={t('settings.newBranch')} checked={draft.newBranch} onChange={(newBranch) => { setDraft({ ...draft, newBranch }) }} />
        </div>
        <div style={note}>{draft.newBranch ? t('settings.newBranchOn') : t('settings.newBranchOff')}</div>
      </fieldset>
      {field('workerImage')}
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }}>
        <legend style={{ fontWeight: 600, marginBottom: 4 }}>{t('settings.preview')}</legend>
        {toggle('previewEnabled', t('settings.previewEnabledHint'))}
        {draft.previewEnabled && toggle('isolatedBrowser', t('settings.isolatedBrowserHint'))}
        {field('previewPorts')}
      </fieldset>
      <div style={row}>
        <Button type="submit" variant="primary" disabled={busy}>{t('settings.save')}</Button>
        {message !== null && <span style={note} role="status" aria-live="polite">{message}</span>}
      </div>
    </form>
  )
}

// ── Choice beside the + button (conversation.input.left) ───────────────────

/** Injected face of the repository label. */
export interface SelectionInjected {
  readonly hooks: { readonly view: HostObservable<CodeSessionView | null>; readonly presetIds: HostObservable<ReadonlySet<string>> }
  readonly sessionId: string
}

/**
 * `owner/name on branch` beside the composer's + button while a Code mode session has a choice and no
 * workspace yet. Gone once the first message starts the workspace.
 * @param props - injected state and translator.
 * @returns the label, or nothing.
 */
export function SelectionLabel({ useView, usePresetIds, sessionId, t }: InjectFace<SelectionInjected> & PropsLocale<typeof NS>): ReactNode {
  const view = useView(v => v)
  const codeMode = usePresetIds(ids => ids.has(sessionId))
  if (!codeMode || view === null || view.status !== 'pending') return null
  const text = t('selection.label', { repository: view.repository, branch: view.baseBranch })
  return (
    <span title={text} style={{ fontSize: 12, opacity: 0.7, alignSelf: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 280 }}>
      {text}
    </span>
  )
}

// ── Environment tab (conversation.view) ────────────────────────────────────

/** Injected face of the Environment tab. */
export interface EnvironmentTabInjected {
  readonly hooks: { readonly view: HostObservable<CodeSessionView | null>; readonly presetIds: HostObservable<ReadonlySet<string>> }
  readonly sessionId: string
  readonly load: () => Promise<Outcome<SessionEnvironment>>
  readonly usage: () => Promise<Outcome<WorkspaceUsage | null>>
  readonly variables: () => Promise<Outcome<SessionVariables>>
  readonly saveVariables: (lines: string[]) => Promise<Outcome<SessionVariables>>
  readonly overrides: () => Promise<Outcome<SessionOverridesView>>
  readonly saveOverrides: (overrides: SessionOverrides) => Promise<Outcome<SessionOverridesView>>
}

/** Default / On / Off choices for this session's overrides of Settings > Code. */
function SessionOverridesEditor({ load, save, t }: { readonly load: () => Promise<Outcome<SessionOverridesView>>; readonly save: (overrides: SessionOverrides) => Promise<Outcome<SessionOverridesView>>; readonly t: T }): ReactNode {
  const [view, setView] = useState<SessionOverridesView | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void load().then((r) => { if (live) { if (r.ok) setView(r.value); else setMessage(t('error.generic', { error: r.message })) } })
    return () => { live = false }
  }, [load, t])
  if (view === null) return message === null ? null : <div style={note} role="alert">{message}</div>
  const choice = view.overrides.preview === undefined ? 'default' : view.overrides.preview ? 'on' : 'off'
  return (
    <section style={{ display: 'grid', gap: 8, maxWidth: 560 }}>
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{t('env.sessionOptions')}</h3>
      <div style={{ ...row, justifyContent: 'space-between' }}>
        <span>{t('env.previewForSession')}</span>
        <SegmentedControl<'default' | 'on' | 'off'>
          id="dsh-code-session-preview"
          label={t('env.previewForSession')}
          value={choice}
          onChange={(next) => {
            const overrides: SessionOverrides = {
              ...view.overrides.isolatedBrowser === undefined ? {} : { isolatedBrowser: view.overrides.isolatedBrowser },
              ...next === 'default' ? {} : { preview: next === 'on' },
            }
            void save(overrides).then((r) => { if (r.ok) { setView(r.value); setMessage(null) } else setMessage(t('error.generic', { error: r.message })) })
          }}
          options={[
            { value: 'default', label: t('env.default', { value: view.defaults.preview ? t('env.on') : t('env.off') }) },
            { value: 'on', label: t('env.on') },
            { value: 'off', label: t('env.off') },
          ]}
        />
      </div>
      {view.effective.preview && (
        <div style={{ ...row, justifyContent: 'space-between' }}>
          <span>{t('env.isolatedForSession')}</span>
          {view.lockdown
            ? <span style={note}>{t('env.isolatedByLockdown')}</span>
            : (
              <SegmentedControl<'default' | 'on' | 'off'>
                id="dsh-code-session-isolated"
                label={t('env.isolatedForSession')}
                value={view.overrides.isolatedBrowser === undefined ? 'default' : view.overrides.isolatedBrowser ? 'on' : 'off'}
                onChange={(next) => {
                  const overrides: SessionOverrides = {
                    ...view.overrides.preview === undefined ? {} : { preview: view.overrides.preview },
                    ...next === 'default' ? {} : { isolatedBrowser: next === 'on' },
                  }
                  void save(overrides).then((r) => { if (r.ok) { setView(r.value); setMessage(null) } else setMessage(t('error.generic', { error: r.message })) })
                }}
                options={[
                  { value: 'default', label: t('env.default', { value: view.defaults.isolatedBrowser ? t('env.on') : t('env.off') }) },
                  { value: 'on', label: t('env.on') },
                  { value: 'off', label: t('env.off') },
                ]}
              />
            )}
        </div>
      )}
      {message !== null && <div style={note} role="alert">{message}</div>}
    </section>
  )
}

/**
 * This session's own variables, editable, beside the defaults it inherits. Saved values apply from the agent's
 * next command; a command already running keeps the values it started with.
 */
function SessionVariablesEditor({ variables, save, t }: { readonly variables: () => Promise<Outcome<SessionVariables>>; readonly save: (lines: string[]) => Promise<Outcome<SessionVariables>>; readonly t: T }): ReactNode {
  const [loaded, setLoaded] = useState<SessionVariables | null>(null)
  const [draft, setDraft] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void variables().then((r) => {
      if (!live) return
      if (r.ok) { setLoaded(r.value); setDraft(r.value.session.join('\n')) } else setMessage(t('error.generic', { error: r.message }))
    })
    return () => { live = false }
  }, [variables, t])
  return (
    <section style={{ display: 'grid', gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{t('env.variables')}</h3>
      {loaded !== null && loaded.defaults.length > 0 && (
        <div style={note}>
          {t('env.variablesDefaults')}
          <pre style={{ ...value, margin: '4px 0 0', fontSize: 12, whiteSpace: 'pre-wrap' }}>{loaded.defaults.join('\n')}</pre>
        </div>
      )}
      <textarea
        aria-label={t('env.variables')}
        rows={5}
        value={draft}
        placeholder="NODE_ENV=development"
        style={{ ...select, maxWidth: 'none', fontFamily: 'monospace' }}
        onChange={(event) => { setDraft(event.target.value) }}
      />
      <div style={note}>{t('env.variablesHint')}</div>
      <div style={row}>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || loaded === null}
          onClick={() => {
            setBusy(true)
            setMessage(null)
            void save(draft.split('\n').map(x => x.trim()).filter(x => x !== '')).then((r) => {
              setBusy(false)
              if (r.ok) { setLoaded(r.value); setDraft(r.value.session.join('\n')); setMessage(t('settings.saved')) } else setMessage(t('error.generic', { error: r.message }))
            })
          }}
        >
          {t('settings.save')}
        </Button>
        {message !== null && <span style={note} role="status" aria-live="polite">{message}</span>}
      </div>
    </section>
  )
}

/**
 * The Environment tab beside Chat and Trajectory: where the session runs and, for a Code session, its account,
 * repository, branches, container, network and limits, the provisioning timeline and live resource usage.
 * @param props - injected loaders, state and translator.
 * @returns the tab content.
 */
export function EnvironmentTab({ useView, usePresetIds, sessionId, load, usage, variables, saveVariables, overrides, saveOverrides, t }: InjectFace<EnvironmentTabInjected> & PropsLocale<typeof NS>): ReactNode {
  const view = useView(v => v)
  const codeMode = usePresetIds(ids => ids.has(sessionId))
  const status = view?.status ?? (codeMode ? 'none' : 'host')
  return (
    <div style={{ padding: '16px 24px', overflow: 'auto', height: '100%', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 960, display: 'grid', gap: 24 }}>
        <EnvironmentPanel
          load={load}
          status={`${status}:${view?.repository ?? ''}:${view?.baseBranch ?? ''}:${String(codeMode)}`}
          side={view !== null && view.status !== 'pending' ? (
            <section>
              <h3 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600 }}>{t('resources.title')}</h3>
              <ResourcesBody usage={usage} t={t} />
            </section>
          ) : undefined}
          t={t}
        />
        {codeMode && <SessionOverridesEditor load={overrides} save={saveOverrides} t={t} />}
        {codeMode && <SessionVariablesEditor variables={variables} save={saveVariables} t={t} />}
      </div>
    </div>
  )
}

// ── Preview tab (conversation.view) ────────────────────────────────────────

/** Injected face of the Preview tab. */
export interface PreviewTabInjected {
  readonly hooks: { readonly view: HostObservable<CodeSessionView | null>; readonly presetIds: HostObservable<ReadonlySet<string>> }
  readonly sessionId: string
  readonly targets: () => Promise<Outcome<PreviewTargets>>
  readonly open: (port: number) => Promise<Outcome<string>>
  readonly mode: () => Promise<Outcome<SessionOverridesView>>
  readonly frame: (port: number, after: number) => Promise<Outcome<IsolatedFrame | null>>
  readonly input: (action: BrowserAction) => Promise<Outcome<boolean>>
  readonly stop: () => Promise<Outcome<void>>
}

const MODIFIER_BITS = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number =>
  (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)

/**
 * The isolated browser: Chromium runs inside the workspace and this view shows its screencast frames, forwarding
 * mouse, wheel and keyboard input. No page code runs in the viewer's browser.
 */
function IsolatedView({ port, frame, input, stop, t }: {
  readonly port: number
  readonly frame: (port: number, after: number) => Promise<Outcome<IsolatedFrame | null>>
  readonly input: (action: BrowserAction) => Promise<Outcome<boolean>>
  readonly stop: () => Promise<Outcome<void>>
  readonly t: T
}): ReactNode {
  const [picture, setPicture] = useState<IsolatedFrame | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  // Long-poll frames while mounted.
  useEffect(() => {
    let live = true
    let seq = 0
    const loop = async (): Promise<void> => {
      while (live) {
        const r = await frame(port, seq)
        if (!live) return
        if (!r.ok) { setError(r.message); await new Promise(res => setTimeout(res, 2000)); continue }
        setError(null)
        if (r.value !== null) { seq = r.value.seq; setPicture(r.value) }
      }
    }
    void loop()
    return () => { live = false }
  }, [port, frame])
  useEffect(() => () => { void stop() }, [stop])
  // Follow the tab's size.
  useEffect(() => {
    if (box === null) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return
      clearTimeout(timer)
      timer = setTimeout(() => { void input({ kind: 'resize', width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) }) }, 250)
    })
    observer.observe(box)
    return () => { observer.disconnect(); clearTimeout(timer) }
  }, [box, input])
  const point = (event: { clientX: number; clientY: number }): { x: number; y: number } | undefined => {
    if (image === null || picture === null) return undefined
    const rect = image.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return undefined
    return { x: (event.clientX - rect.left) * (picture.width / rect.width), y: (event.clientY - rect.top) * (picture.height / rect.height) }
  }
  const button = (b: number): 'left' | 'middle' | 'right' => b === 1 ? 'middle' : b === 2 ? 'right' : 'left'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ ...row, padding: '6px 12px', borderBottom: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,.25))' }}>
        <Button size="sm" variant="outline" onClick={() => { void input({ kind: 'history', action: 'back' }) }}>{t('previewTab.back')}</Button>
        <Button size="sm" variant="outline" onClick={() => { void input({ kind: 'history', action: 'forward' }) }}>{t('previewTab.forward')}</Button>
        <Button size="sm" variant="outline" onClick={() => { void input({ kind: 'history', action: 'reload' }) }}>{t('previewTab.reload')}</Button>
        <span style={{ ...note, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{picture?.url ?? ''}</span>
        <span style={note}>{t('previewTab.isolatedBrowser')}</span>
      </div>
      {error !== null && <div style={{ ...note, padding: 12 }} role="alert">{t('error.generic', { error })}</div>}
      <div
        ref={setBox}
        tabIndex={0}
        style={{ flex: 1, minHeight: 0, overflow: 'hidden', outline: 'none', background: '#fff', position: 'relative' }}
        onKeyDown={(event) => {
          event.preventDefault()
          const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey
          void input({ kind: 'key', event: 'keyDown', key: event.key, code: event.code, text: printable ? event.key : event.key === 'Enter' ? '\r' : '', keyCode: event.keyCode, modifiers: MODIFIER_BITS(event) })
        }}
        onKeyUp={(event) => {
          event.preventDefault()
          void input({ kind: 'key', event: 'keyUp', key: event.key, code: event.code, text: '', keyCode: event.keyCode, modifiers: MODIFIER_BITS(event) })
        }}
      >
        {picture === null
          ? <div style={{ ...note, padding: 16 }}>{t('previewTab.starting')}</div>
          : (
            <img
              ref={setImage}
              alt={t('previewTab.frameTitle', { port: String(port) })}
              src={`data:image/jpeg;base64,${picture.image}`}
              draggable={false}
              style={{ display: 'block', maxWidth: '100%', maxHeight: '100%', userSelect: 'none' }}
              onContextMenu={(event) => { event.preventDefault() }}
              onMouseDown={(event) => {
                event.preventDefault()
                box?.focus()
                const p = point(event)
                if (p !== undefined) void input({ kind: 'mouse', event: 'mousePressed', ...p, button: button(event.button), clickCount: event.detail || 1, modifiers: MODIFIER_BITS(event) })
              }}
              onMouseUp={(event) => {
                const p = point(event)
                if (p !== undefined) void input({ kind: 'mouse', event: 'mouseReleased', ...p, button: button(event.button), clickCount: event.detail || 1, modifiers: MODIFIER_BITS(event) })
              }}
              onMouseMove={(event) => {
                const p = point(event)
                if (p !== undefined && event.buttons === 0) void input({ kind: 'mouse', event: 'mouseMoved', ...p, button: 'none', clickCount: 0, modifiers: MODIFIER_BITS(event) })
              }}
              onWheel={(event) => {
                const p = point(event)
                if (p !== undefined) void input({ kind: 'wheel', ...p, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: MODIFIER_BITS(event) })
              }}
            />
          )}
      </div>
    </div>
  )
}

/** The same capabilities the preview response grants through its CSP; never allow-same-origin. */
const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads'

/**
 * The app running in the Code workspace, embedded in this browser. It loads through the authenticated preview
 * route (Harness to container, never the other way), in a sandboxed frame with an opaque origin, so the page
 * cannot reach the dsh page, its storage or its token. Ports are found from what the workspace listens on.
 * @param props - injected loaders, state and translator.
 * @returns the preview.
 */
export function PreviewTab({ useView, usePresetIds, sessionId, targets, open, mode, frame, input, stop, t }: InjectFace<PreviewTabInjected> & PropsLocale<typeof NS>): ReactNode {
  const view = useView(v => v)
  const codeMode = usePresetIds(ids => ids.has(sessionId))
  const ready = view !== null && view.status === 'ready'
  const [list, setList] = useState<PreviewTargets | null>(null)
  const [port, setPort] = useState<number | null>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [frameKey, setFrameKey] = useState(0)
  const [isolated, setIsolated] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    const check = (): void => { void mode().then((r) => { if (live && r.ok) setIsolated(r.value.effective.preview && r.value.effective.isolatedBrowser) }) }
    check()
    const timer = setInterval(check, 5000)
    return () => { live = false; clearInterval(timer) }
  }, [mode])
  useEffect(() => {
    if (!ready) return
    let live = true
    const tick = (): void => {
      void targets().then((r) => {
        if (!live) return
        if (r.ok) setList(r.value)
        else setError(r.message)
      })
    }
    tick()
    const timer = setInterval(tick, 3000)
    return () => { live = false; clearInterval(timer) }
  }, [ready, targets])
  const openable = (list?.targets ?? []).filter(p => p.listening && p.allowed)
  // Pick the first open port by itself; keep the user's choice while it stays open.
  useEffect(() => {
    if (port !== null && openable.some(p => p.port === port)) return
    setPort(openable[0]?.port ?? null)
  }, [openable.map(p => p.port).join(','), port])
  useEffect(() => {
    if (port === null || isolated !== false) { setSrc(null); return }
    let live = true
    setError(null)
    void open(port).then((r) => {
      if (!live) return
      if (r.ok) setSrc(r.value)
      else { setSrc(null); setError(r.message) }
    })
    return () => { live = false }
  }, [port, open, isolated])
  if (!codeMode) return <div style={{ ...note, padding: 16 }}>{t('previewTab.notCode')}</div>
  if (!ready) return <div style={{ ...note, padding: 16 }}>{t('previewTab.notReady')}</div>
  if (error !== null && /Preview is off/.test(error)) return <div style={{ ...note, padding: 16 }}>{t('previewTab.off')}</div>
  const blocked = (list?.targets ?? []).filter(p => !(p.listening && p.allowed))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ ...row, padding: '8px 12px', borderBottom: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,.25))' }}>
        {openable.map(p => (
          <Button key={p.port} size="sm" variant={p.port === port ? 'primary' : 'outline'} onClick={() => { setPort(p.port) }}>{`:${p.port}`}</Button>
        ))}
        {port !== null && isolated === false && <Button size="sm" variant="outline" onClick={() => { setFrameKey(k => k + 1) }}>{t('previewTab.reload')}</Button>}
        {blocked.map(p => (
          <span key={p.port} style={note}>{`:${p.port} ${!p.allowed ? t('preview.notAllowed') : t('preview.notRunning')}`}</span>
        ))}
        <span style={{ ...note, marginLeft: 'auto' }}>{isolated === true ? t('previewTab.isolatedBrowser') : t('previewTab.isolated')}</span>
      </div>
      {error !== null && <div style={{ ...note, padding: 12 }} role="alert">{t('error.generic', { error })}</div>}
      {isolated === true && port !== null
        ? <IsolatedView key={port} port={port} frame={frame} input={input} stop={stop} t={t} />
        : src === null
        ? <div style={{ ...note, padding: 16 }}>{list === null ? t('picker.loading') : t('preview.nothingListening')}</div>
        : (
          <iframe
            key={`${src}#${frameKey}`}
            title={t('previewTab.frameTitle', { port: String(port) })}
            src={src}
            sandbox={PREVIEW_SANDBOX}
            referrerPolicy="no-referrer"
            style={{ flex: 1, width: '100%', border: 0, background: '#fff' }}
          />
        )}
    </div>
  )
}
