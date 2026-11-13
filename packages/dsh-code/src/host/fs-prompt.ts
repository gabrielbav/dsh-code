/**
 * `ctx.fs` provider for the loaders of prompt files in the Code preset (`CLAUDE.md`/`AGENTS.md` instructions and
 * skills). Those loaders read two kinds of files:
 *
 * - the repository's own files, inside the session checkout: read through the container, like every Code file
 *   operation, so a repository symlink (for example `CLAUDE.md -> ~/.aws/credentials`) resolves inside the
 *   sandbox, where only the checkout exists;
 * - the user's and the Harness's own files (`~/.dsh`, `~/.agents`, bundled skills): read from the host, read-only.
 *   The sandbox cannot write there, so it cannot plant a link there.
 *
 * Anything else under the Code data folder (other checkouts, mirrors, caches, records) reads as absent, and every
 * write is refused. The agent's file tools never use this provider; they stay on the strict container provider.
 */
import { lstat, open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { realpathSync, type Stats } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { FsError, FsTargetKey, FsVersion, type FsDirEntry, type FsInfo, type FsPathInfo, type FsTarget } from '@deepseek-ai/dsh-fs'
import { ContainerFileSystem } from './fs-container.ts'

type Zone = 'workspace' | 'data' | 'host'

const absent = (path: string): FsError => new FsError(`"${path}" does not exist`, 'FS_NOT_FOUND')
const readOnly = (path: string): FsError => new FsError(`cannot change "${path}": prompt files are read-only`, 'FS_SANDBOX_DENIED')
const version = (info: Stats): FsVersion => FsVersion(`${info.ino}:${info.size}:${info.mtimeMs}`)
const kind = (info: Stats): 'file' | 'directory' | 'other' => info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other'
const hostTarget = (path: string): FsTarget => ({ targetKey: FsTargetKey(path), displayPath: path })

/** Container reads inside a checkout, host reads outside the Code data folder, nothing in between; never writes. */
export class PromptFileSystem extends ContainerFileSystem {
  private zone(path: string): Zone {
    const target = resolve(path)
    if (this.workspaces.owning(target) !== undefined) return 'workspace'
    // Both spellings of the data folder: as configured, and with its own symlinks resolved (macOS /var is a link to
    // /private/var), so a resolved link target is still recognised as Code data.
    for (const dataDir of this.dataDirs()) if (target === dataDir || target.startsWith(`${dataDir}/`)) return 'data'
    return 'host'
  }

  private dataDirs(): string[] {
    const configured = resolve(this.workspaces.config.dataDir)
    let real = configured
    try { real = realpathSync(configured) } catch { /* dataDir not created yet: the configured spelling is the only one */ }
    return real === configured ? [configured] : [configured, real]
  }

  /** A host path only after symlinks are resolved, so a host link cannot point back into the Code data folder. */
  private async hostPath(path: string): Promise<string> {
    const real = await realpath(path).catch(() => resolve(path))
    if (this.zone(real) !== 'host') throw absent(path)
    return real
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const cwd = opts?.cwd ?? this.config.cwd
    const target = isAbsolute(path) ? resolve(path) : resolve(cwd, path)
    const zone = this.zone(target)
    if (zone === 'workspace') return super.resolve(target, { cwd: this.zone(cwd) === 'workspace' ? cwd : target, ...opts?.signal === undefined ? {} : { signal: opts.signal } })
    if (zone === 'data') throw absent(path)
    return hostTarget(target)
  }

  override processPathFromHostPath(hostPath: string): string | undefined {
    return isAbsolute(hostPath) && this.zone(hostPath) !== 'data' ? resolve(hostPath) : undefined
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const path = String(target.targetKey)
    const zone = this.zone(path)
    if (zone === 'workspace') return super.stat(target, signal)
    if (zone === 'data') return undefined
    try {
      const info = await stat(await this.hostPath(path))
      return { version: version(info), type: kind(info), size: info.size }
    } catch {
      // Missing, unreadable or redirected into the Code data folder: absent to the loaders.
      return undefined
    }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const target = isAbsolute(path) ? resolve(path) : resolve(opts?.cwd ?? this.config.cwd, path)
    const zone = this.zone(target)
    if (zone === 'workspace') return super.lstat(target, { cwd: target }, signal)
    if (zone === 'data') return undefined
    try {
      const info = await lstat(target)
      return { version: version(info), type: info.isSymbolicLink() ? 'symlink' : kind(info), size: info.size }
    } catch {
      // Missing or unreadable host path: absent to the loaders.
      return undefined
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const path = String(target.targetKey)
    const zone = this.zone(path)
    if (zone === 'workspace') return super.readText(target, signal)
    if (zone === 'data') throw absent(path)
    return readFile(await this.hostPath(path), { encoding: 'utf8', ...signal === undefined ? {} : { signal } })
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const path = String(target.targetKey)
    if (this.zone(path) === 'workspace') return super.streamText(target, signal)
    const text = await this.readText(target, signal)
    return (async function* () { yield text })()
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const path = String(target.targetKey)
    const zone = this.zone(path)
    if (zone === 'workspace') return super.readBytes(target, signal, maxBytes)
    if (zone === 'data') throw absent(path)
    const bytes = await readFile(await this.hostPath(path), signal === undefined ? {} : { signal })
    return bytes.subarray(0, maxBytes)
  }

  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    const path = String(target.targetKey)
    const zone = this.zone(path)
    if (zone === 'workspace') return super.readByteRange(target, range, signal)
    if (zone === 'data') throw absent(path)
    const handle = await open(await this.hostPath(path), 'r')
    try {
      const buffer = new Uint8Array(range.length)
      const { bytesRead } = await handle.read(buffer, 0, range.length, range.offset)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const path = String(target.targetKey)
    const zone = this.zone(path)
    if (zone === 'workspace') return super.listDir(target, signal)
    if (zone === 'data') throw absent(path)
    const directory = await this.hostPath(path)
    const entries: FsDirEntry[] = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(path, entry.name)
      // Entries pointing into the Code data folder are hidden, like a direct read of them.
      if (this.zone(child) === 'data') continue
      entries.push({ name: basename(child), type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other', target: hostTarget(child) })
    }
    return entries
  }

  override async watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>> {
    if (this.zone(String(target.targetKey)) === 'workspace') return super.watch(target, changed, signal)
    // Host prompt files are not watched in Code sessions; they reload with the session.
    return async () => {}
  }

  override async writeText(target: FsTarget): Promise<never> { throw readOnly(String(target.targetKey)) }
  override async editText(target: FsTarget): Promise<never> { throw readOnly(String(target.targetKey)) }
  override async patchText(target: FsTarget): Promise<never> { throw readOnly(String(target.targetKey)) }
  override async deleteFile(target: FsTarget): Promise<never> { throw readOnly(String(target.targetKey)) }
  override async moveFile(source: FsTarget): Promise<never> { throw readOnly(String(source.targetKey)) }
}

export default PromptFileSystem
