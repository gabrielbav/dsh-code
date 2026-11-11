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
}

/** Settings plus whether they can be saved to the profile. */
export interface CodeSettingsView {
  readonly settings: CodeSettings
  readonly writable: boolean
}
