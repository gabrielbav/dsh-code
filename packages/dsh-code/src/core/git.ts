/**
 * Host-side Git operations for Code workspaces. Clone and fetch run in the
 * trusted host process with the host's existing Git credentials, so no Git
 * credential ever enters a workspace container. Once the container exists
 * the checkout is sandbox-writable and therefore untrusted: the host never
 * runs Git inside it again (repository config can name hooks, filters and
 * fsmonitor commands). Status, diff and commit run inside the container;
 * pushes import a Git bundle the sandbox writes into a host-owned mirror and
 * push from there.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { RepositoryRef } from '../types.ts'

export type { RepositoryRef } from '../types.ts'

/** Runs `git` with argv in a directory. */
export type GitRunner = (args: readonly string[], cwd?: string) => Promise<string>

/** Failure of a git invocation, with stderr kept for diagnostics. */
export class GitError extends Error {
  /**
   * @param args - git argv.
   * @param stderr - captured stderr.
   */
  constructor(readonly args: readonly string[], readonly stderr: string) {
    super(`git ${args[0] ?? ''} failed: ${stderr.trim()}`)
    this.name = 'GitError'
  }
}

/**
 * Default runner. Prompts are disabled so a missing credential fails instead of hanging.
 * @param binary - git executable.
 * @param prefix - arguments placed before every command, such as credential helper config.
 * @returns a runner.
 */
export function gitRunner(binary = 'git', prefix: readonly string[] = []): GitRunner {
  return (args, cwd) => new Promise((resolve, reject) => {
    execFile(binary, [...prefix, ...args], {
      cwd, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' },
    }, (error, stdout, stderr) => {
      if (error !== null) reject(new GitError(args, stderr || error.message))
      else resolve(stdout.trim())
    })
  })
}

/**
 * Derive a collision-free working branch name for one session.
 * @param baseBranch - the selected base branch.
 * @param sessionId - the logical session id.
 * @param random - entropy source (tests pass a fixed value).
 * @returns `dsh-code/<base>-<session8>-<rand4>`.
 */
export function workingBranchName(baseBranch: string, sessionId: string, random: () => string = () => randomBytes(2).toString('hex')): string {
  const base = baseBranch.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'main'
  const session = sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase()
  return `dsh-code/${base}-${session}-${random()}`
}

/** Result of preparing a checkout. */
export interface Checkout {
  readonly path: string
  readonly baseBranch: string
  readonly baseCommit: string
  readonly workingBranch: string
}

/** Git operations bound to a runner. */
export class Git {
  /** @param run - git runner. */
  constructor(private readonly run: GitRunner = gitRunner()) {}

  /**
   * Resolve a branch to a commit on the remote without cloning.
   * @param cloneUrl - repository URL.
   * @param branch - branch name.
   * @returns full commit SHA.
   */
  async resolveRemoteBranch(cloneUrl: string, branch: string): Promise<string> {
    const out = await this.run(['ls-remote', '--exit-code', cloneUrl, `refs/heads/${branch}`])
    const sha = out.split(/\s+/)[0] ?? ''
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new GitError(['ls-remote'], `branch not found: ${branch}`)
    return sha
  }

  /**
   * Clone a repository, pin the base commit and create the working branch.
   * @param repo - repository.
   * @param baseBranch - base branch.
   * @param path - empty destination directory.
   * @param workingBranch - new branch name.
   * @returns the checkout facts.
   */
  async prepareCheckout(repo: RepositoryRef, baseBranch: string, path: string, workingBranch: string): Promise<Checkout> {
    await this.run(['clone', '--branch', baseBranch, '--single-branch', '--no-tags', '--', repo.cloneUrl, path])
    const baseCommit = await this.run(['rev-parse', 'HEAD'], path)
    await this.run(['checkout', '-b', workingBranch, baseCommit], path)
    return { path, baseBranch, baseCommit, workingBranch }
  }

  /**
   * Create the host-owned bare mirror that pushes on the session's behalf.
   * The workspace checkout is writable by the sandbox, so the host never runs
   * Git with the workspace's own configuration; it fetches from it as an
   * untrusted remote instead.
   * @param repo - repository.
   * @param mirrorPath - host-only directory for the bare mirror.
   */
  async createMirror(repo: RepositoryRef, mirrorPath: string): Promise<void> {
    await this.run(['init', '--bare', '--quiet', mirrorPath])
    await this.run(['remote', 'add', 'origin', repo.cloneUrl], mirrorPath)
  }

  /**
   * Import the session's working branch from a Git bundle the sandbox wrote,
   * then push it to origin. Reading a bundle file never consults the
   * untrusted checkout's configuration, hooks or filters; the bundle is
   * copied out of the sandbox-writable tree only when it is a regular file.
   * @param mirrorPath - host-only bare mirror.
   * @param bundlePath - host-only copy of the bundle.
   * @param workingBranch - the session's branch.
   * @returns the pushed commit SHA.
   */
  async pushFromBundle(mirrorPath: string, bundlePath: string, workingBranch: string): Promise<string> {
    if (!/^dsh-code\/[A-Za-z0-9._-]+$/.test(workingBranch)) throw new GitError(['push'], `refusing to push non-session branch ${workingBranch}`)
    const ref = `refs/heads/${workingBranch}`
    await this.run(['bundle', 'verify', '--quiet', bundlePath], mirrorPath)
    await this.run(['fetch', '--no-tags', '--no-recurse-submodules', bundlePath, `+${ref}:${ref}`], mirrorPath)
    const sha = await this.run(['rev-parse', ref], mirrorPath)
    await this.run(['push', 'origin', `${ref}:${ref}`], mirrorPath)
    return sha
  }
}
