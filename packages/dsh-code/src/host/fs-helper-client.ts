/**
 * Host end of the in-container file helper: one long-lived child process per
 * workspace (normally `docker exec -i <container> node /opt/dsh-code/fs-helper.js <root>`),
 * spoken to in JSON lines. The helper runs in the sandbox, so its answers are
 * untrusted input: lines are size-capped, shapes are checked, and every
 * target it returns must lie in the workspace root.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { FsError, FsTargetKey, type FsErrorCode, type FsTarget } from '@deepseek-ai/dsh-fs'
import { FS_ERROR_CODES } from '@deepseek-ai/dsh-fs'
import { under, type HelperRequest, type HelperResponse } from '../worker/fs-protocol.ts'

/** Largest answer line accepted from the helper (base64 of a large read plus framing). */
export const MAX_LINE_BYTES = 256 * 1024 * 1024

type Pending = {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly chunk?: (text: string) => void
}

type Body = HelperRequest extends infer R ? R extends { readonly id: number } ? Omit<R, 'id'> : never : never

/** Path-shaped answer check. */
export function checkTarget(value: unknown, root: string): FsTarget {
  if (value === null || typeof value !== 'object') throw new FsError('file helper returned a malformed target', 'FS_IO_ERROR')
  const { targetKey, displayPath } = value as { targetKey?: unknown; displayPath?: unknown }
  if (typeof targetKey !== 'string' || typeof displayPath !== 'string' || !targetKey.startsWith('/') || targetKey.split('/').includes('..')) {
    throw new FsError('file helper returned a malformed target', 'FS_IO_ERROR')
  }
  if (!under(targetKey, root)) throw new FsError(`cannot access "${displayPath}": outside the Code workspace`, 'FS_SANDBOX_DENIED')
  return { targetKey: FsTargetKey(targetKey), displayPath }
}

function fsError(error: { readonly code?: unknown; readonly message?: unknown } | undefined): FsError {
  const code = typeof error?.code === 'string' && (FS_ERROR_CODES as readonly string[]).includes(error.code) ? error.code as FsErrorCode : 'FS_IO_ERROR'
  const message = typeof error?.message === 'string' ? error.message.slice(0, 4096) : 'file operation failed'
  return new FsError(message, code)
}

/** One helper process. */
export class FsHelperClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private buffer = ''
  private failure: Error | undefined

  /**
   * @param argv - command that starts the helper (`docker exec -i … node /opt/dsh-code/fs-helper.js <root>`).
   * @param root - canonical workspace root, the confinement boundary for answers.
   */
  constructor(argv: readonly string[], readonly root: string) {
    const [command, ...args] = argv
    if (command === undefined) throw new Error('file helper argv must not be empty')
    // The Docker CLI is trusted host code and keeps its own environment (DOCKER_HOST, contexts);
    // `docker exec` forwards none of it into the container.
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (data: string) => { this.receive(data) })
    let stderr = ''
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (data: string) => { stderr = (stderr + data).slice(-2048) })
    this.child.on('error', (error) => { this.fail(error) })
    this.child.on('close', (code) => { this.fail(new Error(`file helper exited (${code ?? 'signal'})${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`)) })
    this.child.stdin.on('error', () => undefined)
  }

  /** @returns whether the helper can take requests. */
  get alive(): boolean {
    return this.failure === undefined
  }

  /**
   * Send one request.
   * @param body - request without id.
   * @param signal - aborts the operation inside the helper.
   * @param chunk - receives streamed chunks.
   * @returns the raw answer value.
   */
  call(body: Body, signal?: AbortSignal, chunk?: (text: string) => void): Promise<unknown> {
    if (this.failure !== undefined) return Promise.reject(new FsError(`the Code workspace file service is unavailable: ${this.failure.message}`, 'FS_IO_ERROR'))
    if (signal?.aborted === true) return Promise.reject(new FsError(`${body.op} aborted`, 'FS_ABORTED'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.write({ id: 0, op: 'abort', target: id })
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const done = (): void => { signal?.removeEventListener('abort', onAbort) }
      this.pending.set(id, {
        resolve: (value) => { done(); resolve(value) },
        reject: (error) => { done(); reject(error) },
        ...(chunk === undefined ? {} : { chunk }),
      })
      this.write({ ...body, id } as HelperRequest)
    })
  }

  /** Stop the helper. */
  close(): void {
    this.child.stdin.end()
    this.child.kill('SIGTERM')
  }

  private write(request: HelperRequest): void {
    this.child.stdin.write(`${JSON.stringify(request)}\n`)
  }

  private receive(data: string): void {
    this.buffer += data
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      this.dispatch(line)
      newline = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.fail(new Error('file helper answer exceeds the size limit'))
      this.child.kill('SIGKILL')
    }
  }

  private dispatch(line: string): void {
    let message: HelperResponse
    try {
      message = JSON.parse(line) as HelperResponse
    } catch {
      return
    }
    if (message === null || typeof message !== 'object' || typeof message.id !== 'number') return
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    if ('chunk' in message) {
      if (typeof message.chunk === 'string') entry.chunk?.(message.chunk)
      return
    }
    this.pending.delete(message.id)
    if (message.ok === true) entry.resolve(message.value)
    else entry.reject(fsError((message as { error?: { code?: unknown; message?: unknown } }).error))
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    for (const entry of this.pending.values()) entry.reject(new FsError(`the Code workspace file service stopped: ${error.message}`, 'FS_IO_ERROR'))
    this.pending.clear()
  }
}
