/**
 * `ctx.subprocess` provider for the Code preset. Every process a Code
 * session's tools start runs inside that session's gVisor container through
 * `docker exec`; the host's local runtime only launches the Docker CLI, and
 * keeps its collection, spill, terminal and teardown behavior. A cwd outside
 * every Code workspace is refused, so nothing falls back to the host.
 *
 * Mount inside the preset group that isolates `subprocess` and `shell`, next
 * to `@deepseek-ai/dsh-bash-local` and `@deepseek-ai/dsh-tool-bash`.
 */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type {
  SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalEnvironment, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { WorkspaceManager, WorkspaceRecord } from '../core/workspaces.ts'
import { WorkspaceError } from '../core/workspaces.ts'
import { CREDENTIAL_NAME } from '../core/environment.ts'
import type {} from './workspaces-service.ts'

/** Environment names never forwarded into a workspace. */
const BLOCKED_ENV = CREDENTIAL_NAME

/**
 * Select the variables a tool asked for explicitly. The container keeps its
 * own base environment; the host process environment is never copied in.
 * @param env - the spec environment (undefined values remove a name).
 * @returns `-e` pairs for docker exec.
 */
export function containerEnv(env: NodeJS.ProcessEnv | Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined || BLOCKED_ENV.test(key) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    out[key] = value
  }
  return out
}

/**
 * Wrap argv so the in-container process leads its own process group and
 * records its id; terminating the Docker CLI alone would leave it running.
 * @param execId - unique id for this process.
 * @param argv - the requested program.
 * @returns argv to run inside the container.
 */
export function supervisedArgv(execId: string, argv: readonly string[]): string[] {
  return ['setsid', 'sh', '-c', `mkdir -p /tmp/.dsh-exec && echo $$ > /tmp/.dsh-exec/${execId} && exec "$@"`, 'dsh-exec', ...argv]
}

/**
 * Map host-only executables to their in-container equivalents. Harness search
 * starts ripgrep by the absolute path of its host binary (a sidecar next to
 * Node or `@vscode/ripgrep`), which does not exist in the container; the
 * worker image ships `rg` on PATH.
 * @param argv - requested argv.
 * @returns argv to run inside the container.
 */
export function containerArgv(argv: readonly string[]): readonly string[] {
  const [command, ...rest] = argv
  if (command === undefined || !command.startsWith('/')) return argv
  const name = command.slice(command.lastIndexOf('/') + 1)
  if (name === 'rg' || name.endsWith('-rg') || /[\\/]@vscode[\\/]ripgrep[\\/]/.test(command)) return ['rg', ...rest]
  return argv
}

/** Docker-backed subprocess runtime. */
export class DockerSubprocessRuntime extends LocalSubprocessRuntime {
  static inject = ['codeWorkspaces']

  /** @param ctx - plugin context inside the Code preset group. */
  constructor(ctx: Context) {
    super(ctx)
  }

  private get workspaces(): WorkspaceManager {
    return this.ctx.codeWorkspaces.manager
  }

  private recordFor(cwd: string): WorkspaceRecord {
    const record = this.workspaces.owning(cwd)
    if (record === undefined) throw new WorkspaceError('unsafe-state', `Code sessions run processes only inside their workspace; ${cwd} is outside every Code workspace`)
    if (record.status !== 'ready') throw new WorkspaceError('unsafe-state', `the Code workspace is ${record.status}; restart it from the session header`)
    return record
  }

  /**
   * Resolution happens inside the container, so names pass through unchanged.
   * @param command - program name or path.
   * @returns the same command.
   */
  override async resolveExecutable(command: string): Promise<string> {
    return command
  }

  /** @returns the container's terminal environment. */
  override async terminalEnvironment(): Promise<SubprocessTerminalEnvironment> {
    return { platform: 'posix', defaultShell: '/bin/bash' }
  }

  /**
   * Spawn inside the owning container.
   * @param spec - the requested process.
   * @returns a handle whose termination also stops the in-container process group.
   */
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const record = this.recordFor(spec.cwd)
    const execId = randomUUID()
    // User variables (defaults, then the session's own) first; the tool's explicit variables win.
    const env = { ...containerEnv(this.workspaces.environmentFor(record.sessionId)), ...containerEnv(spec.env) }
    const argv = ['docker', ...this.workspaces.execArgv(record, supervisedArgv(execId, containerArgv(spec.argv)), spec.cwd, env, false)]
    const handle = super.spawn({ ...spec, argv, cwd: this.workspaces.config.dataDir, env: undefined, signal: undefined })
    const stop = (): void => {
      void this.killGroup(record, execId)
      handle.terminate()
    }
    spec.signal?.addEventListener('abort', stop, { once: true })
    void handle.done.finally(() => { spec.signal?.removeEventListener('abort', stop) })
    if (spec.signal?.aborted === true) stop()
    return Object.freeze({
      stdin: handle.stdin, stdout: handle.stdout, stderr: handle.stderr, control: handle.control,
      collected: handle.collected, done: handle.done,
      terminate: stop,
      waitForExit: (signal?: AbortSignal) => handle.waitForExit(signal),
    })
  }

  /**
   * Allocate a terminal inside the owning container.
   * @param spec - the requested terminal.
   * @returns the local terminal handle around `docker exec -it`.
   */
  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const record = this.recordFor(spec.cwd)
    const execId = randomUUID()
    const env = { ...containerEnv(this.workspaces.environmentFor(record.sessionId)), ...containerEnv(spec.env), TERM: spec.terminalType }
    const argv = ['docker', ...this.workspaces.execArgv(record, supervisedArgv(execId, containerArgv(spec.argv)), spec.cwd, env, true)]
    const handle = await super.spawnTerminal({ ...spec, argv, cwd: this.workspaces.config.dataDir, env: undefined })
    const terminate = async (): Promise<void> => {
      await this.killGroup(record, execId)
      await handle.terminate()
    }
    return new Proxy(handle, { get: (target, key, receiver) => key === 'terminate' ? terminate : Reflect.get(target, key, receiver) as unknown })
  }

  private async killGroup(record: WorkspaceRecord, execId: string): Promise<void> {
    const script = `f=/tmp/.dsh-exec/${execId}; [ -f "$f" ] || exit 0; p=$(cat "$f"); kill -TERM -"$p" 2>/dev/null; sleep 2; kill -KILL -"$p" 2>/dev/null; rm -f "$f"`
    await this.workspaces.runInside(record, ['sh', '-c', script]).catch(() => undefined)
  }
}

export default DockerSubprocessRuntime
