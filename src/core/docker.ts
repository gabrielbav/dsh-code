/**
 * Thin, injectable wrapper over the Docker CLI. Every Docker interaction in
 * dsh-code goes through {@link DockerCli} so the trusted host process never
 * mounts or exposes the Docker socket to a workspace, and tests can replace
 * the runner without a daemon.
 */
import { execFile } from 'node:child_process'

/** Result of one Docker CLI invocation. */
export interface DockerResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs one `docker` argv and resolves with its exit code and captured output. */
export type DockerRunner = (args: readonly string[], options?: { readonly input?: string; readonly signal?: AbortSignal }) => Promise<DockerResult>

/** Structured failure of a Docker CLI call. */
export class DockerError extends Error {
  /**
   * @param args - the docker argv that failed.
   * @param result - exit code and output of the failed call.
   */
  constructor(readonly args: readonly string[], readonly result: DockerResult) {
    super(`docker ${args[0] ?? ''} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`)
    this.name = 'DockerError'
  }
}

/**
 * Create the default runner that spawns the `docker` binary.
 * @param binary - docker executable path or name.
 * @returns a runner that never rejects on non-zero exit.
 */
export function processRunner(binary = 'docker'): DockerRunner {
  return (args, options = {}) => new Promise((resolve, reject) => {
    const child = execFile(binary, [...args], { maxBuffer: 64 * 1024 * 1024, signal: options.signal }, (error, stdout, stderr) => {
      if (error !== null && typeof (error as NodeJS.ErrnoException).code === 'string') {
        reject(error)
        return
      }
      resolve({ code: error === null ? 0 : (error as { code?: number }).code ?? 1, stdout, stderr })
    })
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
}

/** Docker operations used by the workspace manager. */
export class DockerCli {
  /** @param run - the CLI runner. */
  constructor(private readonly run: DockerRunner = processRunner()) {}

  /**
   * Run docker and throw {@link DockerError} on non-zero exit.
   * @param args - docker argv.
   * @param signal - optional cancellation.
   * @returns trimmed stdout.
   */
  async exec(args: readonly string[], signal?: AbortSignal): Promise<string> {
    const result = await this.run(args, { signal })
    if (result.code !== 0) throw new DockerError(args, result)
    return result.stdout.trim()
  }

  /**
   * Run docker without throwing.
   * @param args - docker argv.
   * @returns the raw result.
   */
  tryExec(args: readonly string[]): Promise<DockerResult> {
    return this.run(args)
  }

  /** @returns the runtimes the daemon reports, or an empty list when the daemon is unreachable. */
  async runtimes(): Promise<string[]> {
    const result = await this.run(['info', '--format', '{{json .Runtimes}}'])
    if (result.code !== 0) return []
    const parsed: unknown = JSON.parse(result.stdout.trim() || '{}')
    return parsed !== null && typeof parsed === 'object' ? Object.keys(parsed) : []
  }

  /**
   * List container ids carrying a label.
   * @param label - `key=value` label filter.
   * @returns container ids, including stopped containers.
   */
  async containersWithLabel(label: string): Promise<string[]> {
    const out = await this.exec(['ps', '-a', '--no-trunc', '--filter', `label=${label}`, '--format', '{{.ID}}'])
    return out === '' ? [] : out.split('\n')
  }

  /**
   * Read container labels and state.
   * @param id - container id or name.
   * @returns labels and whether it is running, or undefined when absent.
   */
  async inspect(id: string): Promise<{ labels: Record<string, string>; running: boolean; runtime: string } | undefined> {
    const result = await this.run(['inspect', '--type', 'container', '--format', '{{json .Config.Labels}}|{{.State.Running}}|{{.HostConfig.Runtime}}', id])
    if (result.code !== 0) return undefined
    const [labels, running, runtime] = result.stdout.trim().split('|')
    return { labels: JSON.parse(labels ?? '{}') as Record<string, string>, running: running === 'true', runtime: runtime ?? '' }
  }

  /**
   * Remove a container if present.
   * @param id - container id or name.
   */
  async removeContainer(id: string): Promise<void> {
    const result = await this.run(['rm', '-f', '-v', id])
    if (result.code !== 0 && !/No such container/i.test(result.stderr)) throw new DockerError(['rm', '-f', '-v', id], result)
  }

  /**
   * Ensure a network exists.
   * @param name - network name.
   * @param args - extra `network create` flags.
   */
  async ensureNetwork(name: string, args: readonly string[]): Promise<void> {
    const found = await this.run(['network', 'inspect', name])
    if (found.code === 0) return
    await this.exec(['network', 'create', ...args, name])
  }

  /**
   * Remove a network if present.
   * @param name - network name.
   */
  async removeNetwork(name: string): Promise<void> {
    const result = await this.run(['network', 'rm', name])
    if (result.code !== 0 && !/not found|No such network/i.test(result.stderr)) throw new DockerError(['network', 'rm', name], result)
  }
}
