/**
 * `ctx.fs` provider for the Code preset: the host filesystem backend fenced
 * to the calling session's workspace for every operation, reads included.
 * A path is admitted only when its canonical form (symlinks resolved) lies in
 * the workspace that owns the resolution cwd, and each operation re-resolves
 * the target and re-checks it against that same workspace before running.
 *
 * Known limitation: a sandboxed process can still race a symlink swap in the
 * interval between the re-check and the host system call. See the package
 * README; the planned fix moves file operations into the container.
 */
import type { Context } from '@deepseek-ai/cordis'
import { realpathSync } from 'node:fs'
import LocalFileSystem, { type Config } from '@deepseek-ai/dsh-fs-local'
import { FsError, type FsDirEntry, type FsEditOutcome, type FsEditRequest, type FsInfo, type FsPathInfo, type FsTarget, type FsVersion, type FsWriteIntent, type FsWriteOutcome, type FsDeleteOutcome, type FsMoveOutcome } from '@deepseek-ai/dsh-fs'
import type { WorkspaceManager } from '../core/workspaces.ts'
import type {} from './workspaces-service.ts'

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

/** Workspace-confined filesystem. */
export class ConfinedFileSystem extends LocalFileSystem {
  static inject = ['codeWorkspaces']

  /**
   * @param ctx - plugin context inside the Code preset group.
   * @param config - local backend configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, config)
  }

  private get workspaces(): WorkspaceManager {
    return this.ctx.codeWorkspaces.manager
  }

  private rootFor(path: string): string {
    const record = this.workspaces.owning(path)
    if (record === undefined || record.status !== 'ready') {
      throw new FsError(`cannot access "${path}": Code sessions may only use files inside their own workspace`, 'FS_SANDBOX_DENIED')
    }
    return realpathSync(record.path)
  }

  private async admit(target: FsTarget, root: string): Promise<FsTarget> {
    const fresh = await super.resolve(String(target.targetKey))
    if (!under(String(fresh.targetKey), root)) {
      throw new FsError(`cannot access "${target.displayPath}": outside the Code workspace`, 'FS_SANDBOX_DENIED')
    }
    return fresh
  }

  private async checked(target: FsTarget): Promise<FsTarget> {
    return this.admit(target, this.rootFor(String(target.targetKey)))
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const root = this.rootFor(opts?.cwd ?? this.config.cwd)
    const target = await super.resolve(path, opts)
    if (!under(String(target.targetKey), root)) {
      throw new FsError(`cannot access "${path}": outside the Code workspace`, 'FS_SANDBOX_DENIED')
    }
    return target
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    await this.resolve(path, opts)
    return super.lstat(path, opts, signal)
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    return super.stat(await this.checked(target), signal)
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return super.readText(await this.checked(target), signal)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return super.streamText(await this.checked(target), signal)
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    return super.readBytes(await this.checked(target), signal, maxBytes)
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    return super.readByteRange(await this.checked(target), range, signal)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    return super.listDir(await this.checked(target), signal)
  }

  override async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome> {
    return super.writeText(await this.checked(target), content, expected, signal)
  }

  override async editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome> {
    return super.editText(await this.checked(target), edit, expected, signal)
  }

  override async patchText(target: FsTarget, hunks: Parameters<LocalFileSystem['patchText']>[1], expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome> {
    return super.patchText(await this.checked(target), hunks, expected, signal)
  }

  override async deleteFile(target: FsTarget, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsDeleteOutcome> {
    return super.deleteFile(await this.checked(target), expected, signal)
  }

  override async moveFile(source: FsTarget, destination: FsTarget, options: Parameters<LocalFileSystem['moveFile']>[2], signal?: AbortSignal): Promise<FsMoveOutcome> {
    const root = this.rootFor(String(source.targetKey))
    return super.moveFile(await this.admit(source, root), await this.admit(destination, root), options, signal)
  }

  override async watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>> {
    return super.watch(await this.checked(target), changed, signal)
  }
}

export default ConfinedFileSystem
