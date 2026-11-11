/** Wire types of the Code workspace Remote API, shared by Host and Client. */

/** Session states from the product spec. */
export type WorkspaceStatus =
  | 'created' | 'provisioning' | 'ready' | 'offline' | 'restarting' | 'failed' | 'deleting' | 'deleted'

/** One mandatory setup check. */
export interface SelfTestCheck {
  readonly id: string
  readonly ok: boolean
  readonly detail: string
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
