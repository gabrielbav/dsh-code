/**
 * File-operation helper that runs INSIDE a Code workspace container. The host
 * `ctx.fs` provider ({@link ../host/fs-container.ts}) starts one per
 * workspace through `docker exec -i` and sends it one JSON request per line;
 * the helper answers one JSON line per request. Every operation is performed
 * by the Harness local filesystem backend itself, so text decoding, versions,
 * atomic publication, literal edits and patch hunks behave exactly as in an
 * ordinary session. Because the process lives in the container, symlinks
 * resolve in the container's mount namespace: a swapped link can only reach
 * what the sandbox could already reach, never a host file.
 *
 * The helper confines targets to the workspace root as a second check; the
 * host repeats the check on every answer and treats the helper as untrusted.
 *
 * Bundled to `worker/fs-helper.js` (no runtime dependencies) and baked into
 * the worker image at `/opt/dsh-code/fs-helper.js`.
 */
import { createInterface } from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { FsError, type FsTarget } from '@deepseek-ai/dsh-fs'
import { handle, type HelperRequest, type HelperResponse } from './fs-protocol.ts'

const root = process.argv[2]
if (root === undefined || !root.startsWith('/')) {
  process.stderr.write('usage: fs-helper <absolute workspace root>\n')
  process.exit(2)
}

const ctx = new Context()
const backend = new LocalFileSystem(ctx, { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 })
const inflight = new Map<number, AbortController>()
let closed = false
const exitWhenIdle = (): void => { if (closed && inflight.size === 0) process.exit(0) }

function send(response: HelperResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`)
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  let request: HelperRequest
  try {
    request = JSON.parse(line) as HelperRequest
  } catch {
    return
  }
  if (request.op === 'abort') {
    inflight.get(request.target)?.abort()
    return
  }
  const controller = new AbortController()
  inflight.set(request.id, controller)
  void handle(backend, root, request, controller.signal, chunk => { send({ id: request.id, chunk }) })
    .then(value => { send({ id: request.id, ok: true, value }) })
    .catch((error: unknown) => {
      const code = error instanceof FsError ? error.code : 'FS_IO_ERROR'
      send({ id: request.id, ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } })
    })
    .finally(() => {
      inflight.delete(request.id)
      exitWhenIdle()
    })
})
lines.on('close', () => {
  closed = true
  exitWhenIdle()
})

export type { FsTarget }
