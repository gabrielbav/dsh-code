/** Wire types of the Code workspace Remote API, shared by Host and Client. */

/** Session states from the product spec. */
export type WorkspaceStatus =
  | 'created' | 'provisioning' | 'ready' | 'offline' | 'restarting' | 'failed' | 'deleting' | 'deleted'

/** One mandatory setup check. */
export interface SelfTestCheck {
  readonly id: string
  readonly ok: boolean
  readonly detail: string
  /** What the user can do to fix a failing check. */
  readonly remedy?: string
  /** A fix Code can run itself, with the user's consent. */
  readonly action?: 'build-worker'
}

/** Mandatory-check report; Code stays disabled unless `ok`. */
export interface SelfTestReport {
  readonly ok: boolean
  readonly checks: readonly SelfTestCheck[]
}

/** Repository identity on a source control host. */
export interface RepositoryRef {
  /** `owner/name`. */
  readonly fullName: string
  /** HTTPS clone URL. */
  readonly cloneUrl: string
}

/** One repository row for the picker. */
export interface RepositorySummary extends RepositoryRef {
  readonly defaultBranch: string
  readonly private: boolean
  readonly updatedAt: string
}

/** Branch list with the default branch identified. */
export interface BranchList {
  readonly defaultBranch: string
  readonly branches: readonly string[]
}

/** Client view of one Code session. */
export interface CodeSessionView {
  readonly sessionId: string
  /** GitHub account (gh login) the workspace clones and pushes with. */
  readonly account: string
  readonly repository: string
  readonly baseBranch: string
  readonly baseCommit?: string
  readonly workingBranch?: string
  readonly status: WorkspaceStatus | 'pending'
  readonly error?: string
}

/** Uncommitted and unpushed work that deleting a workspace would lose. */
export interface PendingWork {
  readonly dirtyFiles: number
  readonly unpushedCommits: number
}

/** A pushed commit. */
export interface PushResult {
  readonly sha: string
  readonly branch: string
}

/** Repositories one gh account can access, for the grouped Repository menu. */
export interface AccountRepositories {
  readonly login: string
  readonly repositories: readonly RepositorySummary[]
  /** Why this account's listing failed; its group is then empty. */
  readonly error?: string
}

/** One recorded provisioning step of a Code workspace. */
export interface ProvisionStep {
  /** Step id: held, checking-runtime, egress-proxy, resolving-revision, cloning, starting-container, health-check, working-directory, ready, failed. */
  readonly step: string
  /** Epoch milliseconds when the step started. */
  readonly time: number
  readonly error?: string
}

/** What the Environment tab shows about where a session runs. */
export interface SessionEnvironment {
  /** `code`: an isolated gVisor workspace; `host`: directly on this computer. */
  readonly mode: 'code' | 'host'
  readonly workingDirectory?: string
  readonly account?: string
  readonly repository?: string
  readonly baseBranch?: string
  readonly baseCommit?: string
  readonly workingBranch?: string
  readonly status?: string
  /** Sandbox options the container was created with (or would be, before the first message). */
  readonly options?: {
    readonly readOnlyWorkspace: boolean
    readonly dependencyCache: boolean
    readonly readOnlyFolders: readonly string[]
    readonly shmMb: number
    readonly lockdown: boolean
  }
  /** Provisioning steps of the latest start, oldest first. */
  readonly steps?: readonly ProvisionStep[]
  /** Egress mode (allowlist, none or open); host layout details are never sent to the browser. */
  readonly network?: string
}

/** Point-in-time resource usage of one workspace container. */
export interface WorkspaceUsage {
  readonly cpuPercent: number
  readonly memoryBytes: number
  readonly memoryLimitBytes: number
  readonly pids: number
  readonly pidsLimit: number
  /** Bytes used by the checkout on the host. */
  readonly diskBytes: number
}

/** Editable Settings > Code values. */
export interface CodeSettings {
  readonly network: 'allowlist' | 'none' | 'open'
  readonly allow: readonly string[]
  readonly privateAllow: readonly string[]
  readonly ports: readonly number[]
  readonly cpus: number
  readonly memoryMb: number
  readonly pids: number
  readonly tmpMb: number
  readonly maxWorkspaces: number
  readonly workerImage: string
  readonly previewPorts: readonly number[]
  /** gh logins left out of the Repository menu. */
  readonly disabledAccounts: readonly string[]
  /** Give each session its own `dsh-code/<hash>` branch; off works on the chosen branch itself. */
  readonly newBranch: boolean
  /** /dev/shm size in MB. */
  readonly shmMb: number
  /** Mount checkouts read-only. */
  readonly readOnlyWorkspace: boolean
  /** Keep a dependency cache per repository. */
  readonly dependencyCache: boolean
  /** Extra host folders mounted read-only at the same path. */
  readonly readOnlyFolders: readonly string[]
  /** Default `NAME=value` variables for every session. */
  readonly environment: readonly string[]
  /** Network none, read-only workspace, no cache and no extra folders, whatever else is set. */
  readonly lockdown: boolean
  /** Preview tab available for Code sessions (a session can override it). */
  readonly previewEnabled: boolean
  /** Preview through Chromium inside the sandbox instead of the viewer's browser (a session can override it). */
  readonly isolatedBrowser: boolean
}

/** Settings plus whether they can be saved to the profile. */
export interface CodeSettingsView {
  readonly settings: CodeSettings
  readonly writable: boolean
}

/** One account the host's gh CLI is signed in with, for Settings > Code. */
export interface GhAccount {
  readonly login: string
}

/** Variables of one session: the Settings defaults and its own values (which win by name). */
export interface SessionVariables {
  readonly defaults: readonly string[]
  readonly session: readonly string[]
}

/** A port the Preview dialog can offer for one session. */
export interface PreviewTarget {
  readonly port: number
  /** A process is listening on it now. */
  readonly listening: boolean
  /** Listening on loopback only: the app must listen on 0.0.0.0 to be previewed. */
  readonly localOnly: boolean
  /** Settings > Code > Preview ports allows it (always true when that list is empty). */
  readonly allowed: boolean
}

/** What the Preview dialog shows. */
export interface PreviewTargets {
  readonly targets: readonly PreviewTarget[]
  /** Settings > Code > Preview ports is not empty, so only those ports can be opened. */
  readonly restricted: boolean
}

/** Per-session overrides of Settings > Code; an absent field follows Settings. */
export interface SessionOverrides {
  readonly preview?: boolean
  readonly isolatedBrowser?: boolean
}

/** A session's overrides and what they resolve to. */
export interface SessionOverridesView {
  readonly overrides: SessionOverrides
  readonly effective: { readonly preview: boolean; readonly isolatedBrowser: boolean }
  readonly defaults: { readonly preview: boolean; readonly isolatedBrowser: boolean }
  /** Lockdown forces the isolated browser. */
  readonly lockdown: boolean
}

/** Latest picture of a session's isolated browser. */
export interface IsolatedFrame {
  readonly seq: number
  /** Base64 JPEG. */
  readonly image: string
  readonly width: number
  readonly height: number
  readonly url: string
}

/** One viewer action for the isolated browser; the host and the bridge both validate it. */
export interface BrowserAction {
  readonly kind: string
  readonly url?: string
  readonly action?: string
  readonly width?: number
  readonly height?: number
  readonly event?: string
  readonly x?: number
  readonly y?: number
  readonly button?: string
  readonly clickCount?: number
  readonly modifiers?: number
  readonly deltaX?: number
  readonly deltaY?: number
  readonly key?: string
  readonly code?: string
  readonly text?: string
  readonly keyCode?: number
}
