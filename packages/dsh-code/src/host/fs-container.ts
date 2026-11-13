/**
 * `ctx.fs` provider for the Code preset: every file operation runs INSIDE the
 * session's gVisor container, through the file helper baked into the worker
 * image. The host never opens a path in the sandbox-writable checkout, so a
 * process in the container that swaps a symlink can only redirect an
 * operation to something the sandbox already sees, never to a host file.
 *
 * The host still refuses any path outside a ready Code workspace and checks
 * every target the helper returns against the workspace root.
 */
import type { Context } from '@deepseek-ai/cordis'
import { isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import z from '@deepseek-ai/schemastery'
import {
  FileSystem, FsError, type FsDeleteOutcome, type FsDirEntry, type FsEditOutcome, type FsEditRequest, type FsInfo, type FsMoveOutcome,
  type FsPathInfo, type FsTarget, type FsVersion, type FsWriteIntent, type FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { WorkspaceManager, WorkspaceRecord } from '../core/workspaces.ts'
import { checkTarget, FsHelperClient } from './fs-helper-client.ts'
import type {} from './workspaces-service.ts'

/** Path of the helper inside the worker image. */
export const FS_HELPER_PATH = '/opt/dsh-code/fs-helper.js'

/** Provider configuration. */
export interface Config {
  cwd: string
  /** Poll interval of {@link ContainerFileSystem.watch}, in ms. */
  watchIntervalMs: number
}

type Hunks = Parameters<FileSystem['patchText']>[1]
type MoveOptions = Parameters<FileSystem['moveFile']>[2]

/** Starts the helper for one workspace; tests replace it. */
export type HelperLauncher = (record: WorkspaceRecord) => FsHelperClient

/** Container-backed filesystem. */
export class ContainerFileSystem extends FileSystem {
  static inject = ['codeWorkspaces']
  static Config: z<Config> = z.object({
    cwd: z.string().default(process.cwd()),
    watchIntervalMs: z.number().default(1000),
  })

  private readonly helpers = new Map<string, FsHelperClient>()
  /** Replaceable for tests. */
  launch: HelperLauncher = record => new FsHelperClient(
    ['docker', ...this.workspaces.execArgv(record, ['node', FS_HELPER_PATH, record.path], record.path, {}, false)],
    record.path,
  )

  /**
   * @param ctx - plugin context inside the Code preset group.
   * @param config - validated configuration.
   */
  constructor(ctx: Context, readonly config: Config) {
    super(ctx)
    ctx.effect(() => () => {
      for (const helper of this.helpers.values()) helper.close()
      this.helpers.clear()
    }, 'dsh-code: close file helpers')
  }

  protected get workspaces(): WorkspaceManager {
    return this.ctx.codeWorkspaces.manager
  }

  private recordFor(path: string): WorkspaceRecord {
    const record = this.workspaces.owning(path)
    if (record === undefined) throw new FsError(`[sandbox: file access denied outside the Code workspace] cannot access "${path}": Code sessions may only use files inside their own workspace`, 'FS_SANDBOX_DENIED')
    if (record.status !== 'ready') throw new FsError(`the Code workspace is ${record.status}; restart it from the session header`, 'FS_IO_ERROR')
    return record
  }

  private helper(record: WorkspaceRecord): FsHelperClient {
    const key = `${record.containerName}:${record.updatedAt}`
    let helper = this.helpers.get(record.containerName)
    if (helper !== undefined && helper.alive && this.keys.get(record.containerName) === key) return helper
    helper?.close()
    helper = this.launch(record)
    this.helpers.set(record.containerName, helper)
    this.keys.set(record.containerName, key)
    return helper
  }

  private readonly keys = new Map<string, string>()

  private async call(path: string, body: Parameters<FsHelperClient['call']>[0], signal?: AbortSignal, chunk?: (text: string) => void): Promise<{ value: unknown; root: string }> {
    const record = this.recordFor(path)
    try {
      const value = await this.helper(record).call(body, signal, chunk)
      return { value, root: record.path }
    } catch (error) {
      // A read-only workspace (permission selector, Settings or Lockdown) answers writes with EROFS; say it in the
      // Harness's sandbox dialect so the model knows this is policy, not a broken file.
      if (error instanceof Error && /EROFS|read-only file system/i.test(error.message)) {
        throw new FsError(`[sandbox: file access denied under read-only mode] ${error.message}. The workspace is read-only; ask the user to switch the session's permission to Workspace Write.`, 'FS_SANDBOX_DENIED')
      }
      throw error
    }
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const cwd = opts?.cwd ?? this.config.cwd
    // A relative path resolves against cwd; an absolute one must still lie in cwd's workspace.
    const record = this.recordFor(cwd)
    if (isAbsolute(path) && this.workspaces.owning(path) !== record) {
      throw new FsError(`[sandbox: file access denied outside the Code workspace] cannot access "${path}"`, 'FS_SANDBOX_DENIED')
    }
    const { value, root } = await this.call(cwd, { op: 'resolve', path, cwd }, opts?.signal)
    return checkTarget(value, root)
  }

  override processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  override processPathFromHostPath(hostPath: string): string | undefined {
    if (!isAbsolute(hostPath)) return undefined
    const path = resolve(hostPath)
    return this.workspaces.owning(path) === undefined ? undefined : path
  }

  override fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const path = relative(this.processPath(parent), this.processPath(child))
    return path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const { value } = await this.call(String(target.targetKey), { op: 'stat', target }, signal)
    return (value ?? undefined) as FsInfo | undefined
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const cwd = opts?.cwd ?? this.config.cwd
    await this.resolve(path, { cwd, ...(signal === undefined ? {} : { signal }) })
    const { value } = await this.call(cwd, { op: 'lstat', path, cwd }, signal)
    return (value ?? undefined) as FsPathInfo | undefined
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const { value } = await this.call(String(target.targetKey), { op: 'readText', target }, signal)
    if (typeof value !== 'string') throw new FsError('file helper returned malformed text', 'FS_IO_ERROR')
    return value
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const chunks: string[] = []
    let wake: (() => void) | undefined
    let finished = false
    let failure: unknown
    const done = this.call(String(target.targetKey), { op: 'streamText', target }, signal, (text) => {
      chunks.push(text)
      wake?.()
    }).then(() => { finished = true }, (error: unknown) => { failure = error; finished = true }).finally(() => { wake?.() })
    // Fail early on resolution errors, like the local backend.
    await Promise.race([done, new Promise<void>((r) => { wake = r })])
    async function* iterate(): AsyncGenerator<string> {
      while (true) {
        while (chunks.length > 0) yield chunks.shift()!
        if (finished) {
          if (failure !== undefined) throw failure
          return
        }
        await new Promise<void>((r) => { wake = r })
      }
    }
    if (finished && failure !== undefined) throw failure
    return iterate()
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const { value } = await this.call(String(target.targetKey), { op: 'readBytes', target, maxBytes }, signal)
    return bytes(value, maxBytes)
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    const { value } = await this.call(String(target.targetKey), { op: 'readByteRange', target, offset: range.offset, length: range.length }, signal)
    return bytes(value, range.length)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const { value, root } = await this.call(String(target.targetKey), { op: 'listDir', target }, signal)
    if (!Array.isArray(value)) throw new FsError('file helper returned a malformed listing', 'FS_IO_ERROR')
    return value.map((entry: FsDirEntry) => ({ ...entry, target: checkTarget(entry.target, root) }))
  }

  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome> {
    const { value } = await this.call(String(target.targetKey), { op: 'writeText', target, content, ...(expected === undefined ? {} : { expected }) }, signal)
    return value as FsWriteOutcome
  }

  override async editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome> {
    const { value } = await this.call(String(target.targetKey), { op: 'editText', target, edit, ...(expected === undefined ? {} : { expected }) }, signal)
    return value as FsEditOutcome
  }

  override async patchText(target: FsTarget, hunks: Hunks, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome> {
    const { value } = await this.call(String(target.targetKey), { op: 'patchText', target, hunks, ...(expected === undefined ? {} : { expected }) }, signal)
    return value as FsEditOutcome
  }

  override async deleteFile(target: FsTarget, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsDeleteOutcome> {
    const { value } = await this.call(String(target.targetKey), { op: 'deleteFile', target, ...(expected === undefined ? {} : { expected }) }, signal)
    return value as FsDeleteOutcome
  }

  override async moveFile(source: FsTarget, destination: FsTarget, options: MoveOptions, signal?: AbortSignal): Promise<FsMoveOutcome> {
    if (this.workspaces.owning(String(destination.targetKey)) !== this.workspaces.owning(String(source.targetKey))) {
      throw new FsError(`cannot move "${source.displayPath}" out of its Code workspace`, 'FS_SANDBOX_DENIED')
    }
    const { value } = await this.call(String(source.targetKey), { op: 'moveFile', source, destination, options }, signal)
    return value as FsMoveOutcome
  }

  /**
   * Observe a target by polling its metadata inside the container; host
   * watchers would follow sandbox-controlled links.
   */
  override async watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>> {
    signal.throwIfAborted()
    const fingerprint = async (): Promise<string> => {
      const info = await this.stat(target)
      if (info?.type !== 'directory') return JSON.stringify(info ?? null)
      return JSON.stringify((await this.listDir(target)).map(e => [e.name, e.version ?? null]))
    }
    let last = await fingerprint()
    signal.throwIfAborted()
    let busy = false
    const timer = setInterval(() => {
      if (busy) return
      busy = true
      void fingerprint().then((next) => {
        if (next !== last) { last = next; changed() }
      }, (error: unknown) => { changed(error instanceof Error ? error : new Error(String(error))) }).finally(() => { busy = false })
    }, this.config.watchIntervalMs)
    return async () => { clearInterval(timer) }
  }
}

function bytes(value: unknown, max: number): Uint8Array {
  if (typeof value !== 'string') throw new FsError('file helper returned malformed bytes', 'FS_IO_ERROR')
  const out = Buffer.from(value, 'base64')
  if (out.byteLength > max) throw new FsError('file helper returned more bytes than requested', 'FS_IO_ERROR')
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
}

export default ContainerFileSystem
