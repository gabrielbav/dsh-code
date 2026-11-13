import { describe, expect, it } from 'vitest'
import { DockerCli, type DockerResult } from '../src/core/docker.ts'
import { parseSize, parseStats, WorkspaceManager } from '../src/core/workspaces.ts'
import { containerArgv } from '../src/host/subprocess-docker.ts'

const ok = (stdout = ''): DockerResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr = 'no'): DockerResult => ({ code: 1, stdout: '', stderr })

function manager(answer: (args: readonly string[]) => DockerResult, workerDir?: string): WorkspaceManager {
  return new WorkspaceManager({
    dataDir: '/tmp/dsh-code-unit', image: 'dsh-code-worker:0.2.0', proxyImage: 'node:24-alpine', proxyDir: '/x',
    ...(workerDir === undefined ? {} : { workerDir }),
    limits: { cpus: 1, memoryMb: 1024, pids: 256, tmpMb: 256 },
    policy: { mode: 'allowlist', allow: [], privateAllow: [], ports: [443] },
    uid: 1000, gid: 1000, maxWorkspaces: 2, previewPorts: [3000],
  }, new DockerCli(async args => answer(args)))
}

describe('guided setup checks', () => {
  it('stops at a missing Docker daemon with a remedy', async () => {
    const report = await manager(() => fail()).selfTest()
    expect(report.ok).toBe(false)
    expect(report.checks).toHaveLength(1)
    expect(report.checks[0]).toMatchObject({ id: 'docker', ok: false })
    expect(report.checks[0]!.remedy).toMatch(/Install Docker/)
  })

  it('reports a missing runsc runtime and a missing image with a build action', async () => {
    const report = await manager((args) => {
      if (args[0] === 'info') return ok('{"runc":{}}')
      if (args[0] === 'image') return fail('No such image')
      return ok()
    }, '/pkg/worker').selfTest()
    expect(report.ok).toBe(false)
    expect(report.checks.find(c => c.id === 'runtime')).toMatchObject({ ok: false })
    expect(report.checks.find(c => c.id === 'runtime')!.remedy).toMatch(/gVisor/)
    expect(report.checks.find(c => c.id === 'image')).toMatchObject({ ok: false, action: 'build-worker' })
    expect(report.checks.some(c => c.id === 'isolation')).toBe(false)
  })

  it('refuses a gVisor probe that is not gVisor', async () => {
    const report = await manager((args) => {
      if (args[0] === 'info') return ok('{"runc":{},"runsc":{}}')
      if (args[0] === 'image') return ok('sha256:abc')
      if (args.includes('dmesg 2>/dev/null | head -n 3; id -u')) return ok('Linux version 6.1\n0')
      return ok()
    }).selfTest()
    expect(report.checks.find(c => c.id === 'isolation')).toMatchObject({ ok: false })
    expect(report.ok).toBe(false)
  })

  it('refuses ports outside a non-empty Preview ports list', async () => {
    await expect(manager(() => ok()).previewAddress('s', 22)).rejects.toThrowError(/not in Settings > Code > Preview ports/)
  })
})

describe('resource stats parsing', () => {
  it('parses docker sizes and stats lines', () => {
    expect(parseSize('12.5MiB')).toBe(Math.round(12.5 * 1024 * 1024))
    expect(parseSize('4GiB')).toBe(4 * 1024 ** 3)
    expect(parseSize('512B')).toBe(512)
    expect(parseSize('1.5kB')).toBe(1500)
    expect(parseSize('garbage')).toBe(0)
    const line = JSON.stringify({ CPUPerc: '12.34%', MemUsage: '100MiB / 1GiB', PIDs: '7' })
    expect(parseStats(line, { cpus: 1, memoryMb: 1024, pids: 256, tmpMb: 64 }, 42)).toEqual({
      cpuPercent: 12.34, memoryBytes: 100 * 1024 * 1024, memoryLimitBytes: 1024 ** 3, pids: 7, pidsLimit: 256, diskBytes: 42,
    })
  })
})

describe('in-container executables', () => {
  it('maps the host ripgrep binary to the worker image rg', () => {
    expect(containerArgv(['/opt/dsh/bin/dsh-rg', '--no-config', 'x'])).toEqual(['rg', '--no-config', 'x'])
    expect(containerArgv(['/home/u/app/node_modules/@vscode/ripgrep/bin/rg', '-n'])).toEqual(['rg', '-n'])
    expect(containerArgv(['/usr/bin/rg'])).toEqual(['rg'])
    expect(containerArgv(['bash', '-c', 'rg x'])).toEqual(['bash', '-c', 'rg x'])
    expect(containerArgv(['/usr/bin/python3'])).toEqual(['/usr/bin/python3'])
  })
})
