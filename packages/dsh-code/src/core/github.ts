/**
 * Source control provider backed by the host's existing GitHub CLI login —
 * the same identity Harness's forge integration uses. Tokens stay with `gh`
 * on the host; nothing here reads them or forwards them to a workspace.
 */
import { execFile } from 'node:child_process'
import type { BranchList, RepositorySummary } from '../types.ts'

export type { BranchList, RepositorySummary } from '../types.ts'

/** Runs `gh` with argv and resolves with stdout. */
export type GhRunner = (args: readonly string[]) => Promise<string>

/** Failure from the GitHub CLI, classified for the UI. */
export class SourceControlError extends Error {
  /**
   * @param code - `auth` when the CLI is not signed in or lost access; `failed` otherwise.
   * @param message - CLI stderr.
   */
  constructor(readonly code: 'auth' | 'missing-cli' | 'failed', message: string) {
    super(message)
    this.name = 'SourceControlError'
  }
}

/**
 * Default runner. `gh` runs in the trusted host process with its own
 * credential sources (keyring, `GH_TOKEN`); nothing it reads is forwarded to
 * a workspace.
 * @param binary - gh executable.
 * @returns a runner.
 */
export function ghRunner(binary = 'gh'): GhRunner {
  return args => new Promise((resolve, reject) => {
    execFile(binary, [...args], { env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) {
        resolve(stdout)
        return
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') reject(new SourceControlError('missing-cli', 'GitHub CLI (gh) is not installed on the host'))
      else if (/auth login|not logged|HTTP 401|Bad credentials|HTTP 403/i.test(stderr)) reject(new SourceControlError('auth', stderr.trim()))
      else reject(new SourceControlError('failed', stderr.trim() || error.message))
    })
  })
}

const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** GitHub operations for Code sessions. */
export class GitHubProvider {
  /** @param gh - CLI runner. */
  constructor(private readonly gh: GhRunner = ghRunner()) {}

  /**
   * Repositories the signed-in identity can access, most recently updated first.
   * @param query - optional search text.
   * @param limit - maximum rows.
   * @returns repositories.
   */
  async repositories(query: string | undefined, limit = 100): Promise<RepositorySummary[]> {
    const raw = await this.gh(['api', '--paginate', '--slurp', `user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`])
    const pages = JSON.parse(raw) as Array<Array<{ full_name: string; clone_url: string; default_branch: string; private: boolean; updated_at: string; archived: boolean }>>
    const needle = query?.trim().toLowerCase() ?? ''
    return pages.flat()
      .filter(r => !r.archived && (needle === '' || r.full_name.toLowerCase().includes(needle)))
      .slice(0, limit)
      .map(r => ({ fullName: r.full_name, cloneUrl: r.clone_url, defaultBranch: r.default_branch, private: r.private, updatedAt: r.updated_at }))
  }

  /**
   * Resolve one repository the identity can access.
   * @param fullName - `owner/name`.
   * @returns its clone URL and default branch.
   */
  async repository(fullName: string): Promise<RepositorySummary> {
    if (!FULL_NAME.test(fullName)) throw new SourceControlError('failed', `invalid repository name: ${fullName}`)
    const r = JSON.parse(await this.gh(['api', `repos/${fullName}`])) as { full_name: string; clone_url: string; default_branch: string; private: boolean; updated_at: string }
    return { fullName: r.full_name, cloneUrl: r.clone_url, defaultBranch: r.default_branch, private: r.private, updatedAt: r.updated_at }
  }

  /**
   * Branches of one repository.
   * @param fullName - `owner/name`.
   * @returns the default branch and every branch name.
   */
  async branches(fullName: string): Promise<BranchList> {
    const repo = await this.repository(fullName)
    const raw = await this.gh(['api', '--paginate', '--slurp', `repos/${fullName}/branches?per_page=100`])
    const names = (JSON.parse(raw) as Array<Array<{ name: string }>>).flat().map(b => b.name)
    const branches = [repo.defaultBranch, ...names.filter(n => n !== repo.defaultBranch).sort()]
    return { defaultBranch: repo.defaultBranch, branches }
  }

  /**
   * Open a pull request from the session branch.
   * @param fullName - `owner/name`.
   * @param head - session working branch.
   * @param base - base branch.
   * @param title - PR title.
   * @param body - PR body.
   * @returns the PR URL.
   */
  async createPullRequest(fullName: string, head: string, base: string, title: string, body: string): Promise<string> {
    if (!FULL_NAME.test(fullName)) throw new SourceControlError('failed', `invalid repository name: ${fullName}`)
    const out = await this.gh(['pr', 'create', '--repo', fullName, '--head', head, '--base', base, '--title', title, '--body', body])
    return out.trim().split('\n').at(-1) ?? ''
  }
}
