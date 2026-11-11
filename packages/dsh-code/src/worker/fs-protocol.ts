/**
 * Wire protocol between the host `ctx.fs` provider and the in-container
 * file helper: one JSON object per line in each direction. {@link handle}
 * executes one request against a filesystem backend confined to a root; the
 * helper runs it inside the container, and unit tests run it on the host.
 */
import { FsError, FsTargetKey, type FileSystem, type FsTarget } from '@deepseek-ai/dsh-fs'

/** Operations that take one target. */
export type TargetOp = 'stat' | 'readText' | 'streamText' | 'listDir' | 'deleteFile'

/** One request from the host. */
export type HelperRequest =
  | { readonly id: number; readonly op: 'resolve' | 'lstat'; readonly path: string; readonly cwd?: string }
  | { readonly id: number; readonly op: TargetOp; readonly target: FsTarget; readonly expected?: unknown }
  | { readonly id: number; readonly op: 'readBytes'; readonly target: FsTarget; readonly maxBytes: number }
  | { readonly id: number; readonly op: 'readByteRange'; readonly target: FsTarget; readonly offset: number; readonly length: number }
  | { readonly id: number; readonly op: 'writeText'; readonly target: FsTarget; readonly content: string; readonly expected?: unknown }
  | { readonly id: number; readonly op: 'editText'; readonly target: FsTarget; readonly edit: unknown; readonly expected?: unknown }
  | { readonly id: number; readonly op: 'patchText'; readonly target: FsTarget; readonly hunks: unknown; readonly expected?: unknown }
  | { readonly id: number; readonly op: 'moveFile'; readonly source: FsTarget; readonly destination: FsTarget; readonly options: unknown }
  | { readonly id: 0; readonly op: 'abort'; readonly target: number }

/** One answer, or one streamed text chunk, from the helper. */
export type HelperResponse =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  | { readonly id: number; readonly chunk: string }

/**
 * Whether a canonical path lies in a root.
 * @param path - canonical absolute path.
 * @param root - canonical absolute root.
 * @returns true for the root itself or a descendant.
 */
export function under(path: string, root: string): boolean {
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  return path === base || path.startsWith(`${base}/`)
}

function denied(path: string): FsError {
  return new FsError(`cannot access "${path}": Code sessions may only use files inside their own workspace`, 'FS_SANDBOX_DENIED')
}

async function confine(backend: FileSystem, root: string, path: string, cwd?: string): Promise<FsTarget> {
  const target = await backend.resolve(path, cwd === undefined ? {} : { cwd })
  if (!under(String(target.targetKey), root)) throw denied(path)
  return target
}

/** Re-resolve a target the caller holds; the canonical key must still be in the root. */
async function fresh(backend: FileSystem, root: string, target: FsTarget): Promise<FsTarget> {
  const key = String(target.targetKey)
  if (!under(key, root)) throw denied(target.displayPath)
  const resolved = await backend.resolve(key)
  if (!under(String(resolved.targetKey), root)) throw denied(target.displayPath)
  return { targetKey: resolved.targetKey, displayPath: target.displayPath }
}

/**
 * Execute one request against a backend confined to `root`.
 * @param backend - the local filesystem backend.
 * @param root - canonical workspace root.
 * @param request - the request.
 * @param signal - cancels the operation.
 * @param chunk - receives streamed text chunks.
 * @returns a JSON-serializable value.
 */
export async function handle(backend: FileSystem, root: string, request: HelperRequest, signal: AbortSignal, chunk: (text: string) => void): Promise<unknown> {
  switch (request.op) {
    case 'resolve':
      return confine(backend, root, request.path, request.cwd)
    case 'lstat': {
      await confine(backend, root, request.path, request.cwd)
      return (await backend.lstat(request.path, request.cwd === undefined ? {} : { cwd: request.cwd }, signal)) ?? null
    }
    case 'stat':
      return (await backend.stat(await fresh(backend, root, request.target), signal)) ?? null
    case 'readText':
      return backend.readText(await fresh(backend, root, request.target), signal)
    case 'streamText': {
      for await (const text of await backend.streamText(await fresh(backend, root, request.target), signal)) chunk(text)
      return null
    }
    case 'readBytes':
      return Buffer.from(await backend.readBytes(await fresh(backend, root, request.target), signal, request.maxBytes)).toString('base64')
    case 'readByteRange':
      return Buffer.from(await backend.readByteRange(await fresh(backend, root, request.target), { offset: request.offset, length: request.length }, signal)).toString('base64')
    case 'listDir': {
      const entries = await backend.listDir(await fresh(backend, root, request.target), signal)
      // A child link that leaves the workspace keeps its name but no target metadata.
      return entries.map(entry => under(String(entry.target.targetKey), root)
        ? entry
        : { name: entry.name, type: 'other' as const, target: { targetKey: FsTargetKey(`${String(request.target.targetKey)}/${entry.name}`), displayPath: entry.target.displayPath } })
    }
    case 'writeText':
      return backend.writeText(await fresh(backend, root, request.target), request.content, request.expected as never, signal)
    case 'editText':
      return backend.editText(await fresh(backend, root, request.target), request.edit as never, request.expected as never, signal)
    case 'patchText':
      return backend.patchText(await fresh(backend, root, request.target), request.hunks as never, request.expected as never, signal)
    case 'deleteFile':
      return backend.deleteFile(await fresh(backend, root, request.target), request.expected as never, signal)
    case 'moveFile':
      return backend.moveFile(await fresh(backend, root, request.source), await fresh(backend, root, request.destination), request.options as never, signal)
    case 'abort':
      return null
    default:
      throw new FsError(`unknown file operation ${(request as { op: string }).op}`, 'FS_IO_ERROR')
  }
}
