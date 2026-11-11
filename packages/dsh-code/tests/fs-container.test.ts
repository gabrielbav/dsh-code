/**
 * The container-backed filesystem, with the file helper run as a local Node
 * process instead of through `docker exec`. The helper protocol, confinement
 * checks and answer validation are the same; the symlink race itself needs
 * the container's mount namespace and is covered by the live Docker test.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { ContainerFileSystem } from '../src/host/fs-container.ts'
import { FsHelperClient } from '../src/host/fs-helper-client.ts'
import type { WorkspaceManager, WorkspaceRecord } from '../src/core/workspaces.ts'

const HELPER = resolve(import.meta.dirname, '../src/worker/fs-helper.ts')

function record(path: string, status: WorkspaceRecord['status'] = 'ready'): WorkspaceRecord {
  return { path, status, containerName: `c-${path.length}`, updatedAt: 't0', sessionId: 's', workspaceId: 'w' } as unknown as WorkspaceRecord
}

class TestFs extends ContainerFileSystem {
  records: WorkspaceRecord[] = []
  launched = 0
  protected override get workspaces(): WorkspaceManager {
    const records = this.records
    return {
      owning: (path: string) => records.find(r => resolve(path) === r.path || resolve(path).startsWith(`${r.path}/`)),
    } as unknown as WorkspaceManager
  }
}

describe('container filesystem', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-code-fs-')))
  const ws = join(base, 'ws')
  const other = join(base, 'other')
  const secret = join(base, 'host-secret.txt')
  let fs: TestFs

  beforeAll(() => {
    mkdirSync(ws)
    mkdirSync(other)
    writeFileSync(secret, 'host secret\n')
    writeFileSync(join(ws, 'a.txt'), 'one\r\ntwo\r\n')
    writeFileSync(join(other, 'b.txt'), 'other workspace\n')
    symlinkSync(secret, join(ws, 'escape'))
    const ctx = new Context()
    fs = new TestFs(ctx, { cwd: ws, watchIntervalMs: 50 })
    fs.records = [record(ws), record(other)]
    fs.launch = (r) => {
      fs.launched++
      return new FsHelperClient([process.execPath, HELPER, r.path], r.path)
    }
  })

  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('resolves, reads and stats inside the workspace', async () => {
    const target = await fs.resolve('a.txt', { cwd: ws })
    expect(String(target.targetKey)).toBe(join(ws, 'a.txt'))
    expect(await fs.readText(target)).toBe('one\r\ntwo\r\n')
    expect(await fs.stat(target)).toMatchObject({ type: 'file', size: 10 })
    expect(new TextDecoder().decode(await fs.readByteRange(target, { offset: 5, length: 3 }))).toBe('two')
    expect((await fs.readBytes(target, undefined, 100)).byteLength).toBe(10)
    const chunks: string[] = []
    for await (const chunk of await fs.streamText(target)) chunks.push(chunk)
    expect(chunks.join('')).toBe('one\r\ntwo\r\n')
  })

  it('edits, writes, patches line endings back, moves and deletes with version guards', async () => {
    const target = await fs.resolve('a.txt', { cwd: ws })
    const info = await fs.stat(target)
    const edited = await fs.editText(target, { oldString: 'two', newString: 'deux', replaceAll: false }, { version: info!.version })
    expect(edited.after).toBe('one\ndeux\n')
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('one\r\ndeux\r\n')
    await expect(fs.editText(target, { oldString: 'one', newString: 'x', replaceAll: false }, { version: info!.version }))
      .rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
    const created = await fs.resolve('dir/new.txt', { cwd: ws })
    mkdirSync(join(ws, 'dir'))
    expect(await fs.writeText(created, 'hello', { kind: 'createIfAbsent' })).toMatchObject({ operation: 'create', before: null })
    await expect(fs.writeText(created, 'again', { kind: 'createIfAbsent' })).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    const moved = await fs.resolve('dir/moved.txt', { cwd: ws })
    expect(await fs.moveFile(created, moved, {})).toMatchObject({ sourceDeleted: true })
    expect(await fs.deleteFile(moved)).toEqual({ before: 'hello' })
    expect(existsSync(join(ws, 'dir/moved.txt'))).toBe(false)
  })

  it('lists a directory without exposing a link that leaves the workspace', async () => {
    const entries = await fs.listDir(await fs.resolve('.', { cwd: ws }))
    const escape = entries.find(e => e.name === 'escape')
    expect(escape).toMatchObject({ type: 'other' })
    expect(String(escape!.target.targetKey)).toBe(join(ws, 'escape'))
    await expect(fs.readText(escape!.target)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('refuses host files, links out of the workspace and other workspaces', async () => {
    await expect(fs.resolve(secret, { cwd: ws })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(fs.resolve('escape', { cwd: ws })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(fs.resolve('../host-secret.txt', { cwd: ws })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(fs.resolve(join(other, 'b.txt'), { cwd: ws })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(fs.resolve('a.txt', { cwd: base })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(fs.lstat('escape', { cwd: ws })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    const a = await fs.resolve('a.txt', { cwd: ws })
    const b = await fs.resolve('b.txt', { cwd: other })
    await expect(fs.moveFile(a, b, {})).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('refuses a workspace that is not ready', async () => {
    const stopped = join(base, 'stopped')
    mkdirSync(stopped)
    fs.records.push(record(stopped, 'offline'))
    await expect(fs.resolve('x', { cwd: stopped })).rejects.toBeInstanceOf(FsError)
  })

  it('notices changes through polling', async () => {
    const target = await fs.resolve('a.txt', { cwd: ws })
    let changes = 0
    const controller = new AbortController()
    const close = await fs.watch(target, () => { changes++ }, controller.signal)
    writeFileSync(join(ws, 'a.txt'), 'changed\n')
    await new Promise(r => setTimeout(r, 400))
    await close()
    expect(changes).toBeGreaterThan(0)
  })

  it('maps host paths only inside a workspace', () => {
    expect(fs.processPathFromHostPath(join(ws, 'a.txt'))).toBe(join(ws, 'a.txt'))
    expect(fs.processPathFromHostPath(secret)).toBeUndefined()
  })
})

describe('file helper client', () => {
  const clients: FsHelperClient[] = []
  afterEach(() => { for (const c of clients.splice(0)) c.close() })

  const fake = (script: string): FsHelperClient => {
    const client = new FsHelperClient([process.execPath, '-e', script], '/workspace/root')
    clients.push(client)
    return client
  }

  it('rejects a target outside the root even when the helper claims it', async () => {
    const { checkTarget } = await import('../src/host/fs-helper-client.ts')
    expect(() => checkTarget({ targetKey: '/etc/passwd', displayPath: 'x' }, '/workspace/root')).toThrowError(/outside the Code workspace/)
    expect(() => checkTarget({ targetKey: '/workspace/root/../x', displayPath: 'x' }, '/workspace/root')).toThrowError(/malformed/)
    expect(() => checkTarget({ targetKey: '/workspace/rootx/a', displayPath: 'x' }, '/workspace/root')).toThrowError(/outside/)
    expect(checkTarget({ targetKey: '/workspace/root/a', displayPath: 'a' }, '/workspace/root')).toEqual({ targetKey: '/workspace/root/a', displayPath: 'a' })
  })

  it('maps unknown error codes to FS_IO_ERROR and fails pending calls when the helper exits', async () => {
    const client = fake(`process.stdin.once('data', d => { const r = JSON.parse(String(d)); process.stdout.write(JSON.stringify({ id: r.id, ok: false, error: { code: 'EVIL', message: 'x' } }) + '\\n'); setTimeout(() => process.exit(3), 50) })`)
    await expect(client.call({ op: 'readText', target: { targetKey: '/workspace/root/a' as never, displayPath: 'a' } })).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
    await new Promise(r => setTimeout(r, 200))
    expect(client.alive).toBe(false)
    await expect(client.call({ op: 'stat', target: { targetKey: '/workspace/root/a' as never, displayPath: 'a' } })).rejects.toMatchObject({ code: 'FS_IO_ERROR' })
  })
})

describe('bundled file helper', () => {
  const bundle = resolve(import.meta.dirname, '../worker/fs-helper.js')
  it.runIf(existsSync(bundle))('runs standalone, without node_modules, as in the worker image', async () => {
    const isolated = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-code-bundle-')))
    const root = join(isolated, 'ws')
    mkdirSync(root)
    writeFileSync(join(root, 'f.txt'), 'bundled\n')
    writeFileSync(join(isolated, 'fs-helper.js'), readFileSync(bundle))
    const client = new FsHelperClient([process.execPath, join(isolated, 'fs-helper.js'), root], root)
    try {
      expect(await client.call({ op: 'readText', target: { targetKey: join(root, 'f.txt') as never, displayPath: 'f.txt' } })).toBe('bundled\n')
    } finally {
      client.close()
      rmSync(isolated, { recursive: true, force: true })
    }
  })
})
