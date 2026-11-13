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
  readonly container?: {
    readonly name: string
    readonly image: string
    readonly runtime: string
    readonly network: string
    readonly cpus: number
    readonly memoryMb: number
  }
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
