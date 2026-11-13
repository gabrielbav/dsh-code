import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PromptFileSystem } from '../src/host/fs-prompt.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-code-prompt-fs-'))
const dataDir = join(root, 'data')
const host = join(root, 'host')
mkdirSync(join(dataDir, 'workspaces', 'w1'), { recursive: true })
mkdirSync(join(dataDir, 'caches'), { recursive: true })
mkdirSync(host, { recursive: true })
writeFileSync(join(host, 'AGENTS.md'), 'global instructions')
writeFileSync(join(dataDir, 'caches', 'secret.txt'), 'other session data')
symlinkSync(join(dataDir, 'caches', 'secret.txt'), join(host, 'sneaky.md'))
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

// The zone logic needs only the manager's workspace lookup and dataDir; no container is involved for host paths.
function providerFor(): PromptFileSystem {
  const fs = Object.create(PromptFileSystem.prototype) as PromptFileSystem
  const manager = {
    config: { dataDir },
    owning: (path: string) => path === join(dataDir, 'workspaces', 'w1') || path.startsWith(`${join(dataDir, 'workspaces', 'w1')}/`) ? { path: join(dataDir, 'workspaces', 'w1') } : undefined,
  }
  Object.defineProperty(fs, 'workspaces', { get: () => manager })
  Object.defineProperty(fs, 'config', { value: { cwd: host, watchIntervalMs: 1000 } })
  return fs
}

describe('prompt-file fs', () => {
  const fs = providerFor()

  it('reads the user\'s and the Harness\'s own files from the host', async () => {
    const target = await fs.resolve(join(host, 'AGENTS.md'))
    expect(await fs.readText(target)).toBe('global instructions')
    expect((await fs.stat(target))?.type).toBe('file')
  })

  it('treats the rest of the Code data folder as absent', async () => {
    await expect(fs.resolve(join(dataDir, 'caches', 'secret.txt'))).rejects.toThrow(/does not exist/)
    expect(await fs.stat({ targetKey: join(dataDir, 'caches', 'secret.txt'), displayPath: '' } as never)).toBeUndefined()
  })

  it('does not follow a host link back into the Code data folder', async () => {
    const target = await fs.resolve(join(host, 'sneaky.md'))
    expect(await fs.stat(target)).toBeUndefined()
    await expect(fs.readText(target)).rejects.toThrow(/does not exist/)
    expect((await fs.listDir(await fs.resolve(host))).map(e => e.name).sort()).toEqual(['AGENTS.md', 'sneaky.md'])
  })

  it('refuses every write', async () => {
    const target = await fs.resolve(join(host, 'AGENTS.md'))
    await expect(fs.writeText(target)).rejects.toThrow(/read-only/)
    await expect(fs.deleteFile(target)).rejects.toThrow(/read-only/)
  })
})
