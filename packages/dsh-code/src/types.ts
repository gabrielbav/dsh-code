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

/** One account the host's gh CLI is signed in with. */
export interface AccountOption {
  readonly login: string
  /** The gh CLI's active account. */
  readonly active: boolean
}

/** Accounts a Code session can use, and the one it uses now. */
export interface AccountList {
  readonly accounts: readonly AccountOption[]
  readonly current: string
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
  readonly container?: {
    readonly name: string
    readonly image: string
    readonly runtime: string
    readonly network: string
    readonly cpus: number
    readonly memoryMb: number
  }
}
