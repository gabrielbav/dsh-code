/**
 * Live Docker + gVisor test. Runs only with DSH_CODE_DOCKER_TESTS=1 on a host
 * where Docker has the runsc runtime and the dsh-code-worker image is built.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DockerCli } from '../../src/core/docker.ts'
import { WorkspaceManager, type WorkspaceRecord } from '../../src/core/workspaces.ts'
import { DEFAULT_ALLOW, type EgressPolicy } from '../../src/egress/policy.ts'
import { supervisedArgv } from '../../src/host/subprocess-docker.ts'
import { FsHelperClient } from '../../src/host/fs-helper-client.ts'
import { FS_HELPER_PATH } from '../../src/host/fs-container.ts'

const enabled = process.env.DSH_CODE_DOCKER_TESTS === '1'
const UPSTREAM = 'dsh-code-test-upstream'
const docker = new DockerCli()

describe.runIf(enabled)('workspaces on Docker + gVisor', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-code-it-'))
  const origin = join(root, 'origin.git')
  const policy: EgressPolicy = { mode: 'allowlist', allow: DEFAULT_ALLOW, privateAllow: [`${UPSTREAM}:8080`], ports: [80, 443] }
  // Its own namespace: the test never sees or removes a running dsh-code's containers, networks or proxy.
  const manager = new WorkspaceManager({
    namespace: `dsh-code-it-${process.pid}`,
    dataDir: join(root, 'data'), image: 'dsh-code-worker:0.2.0', proxyImage: 'node:24-alpine',
    proxyDir: resolve(import.meta.dirname, '../../src/egress'),
    workerDir: resolve(import.meta.dirname, '../../worker'),
    limits: { cpus: 1, memoryMb: 1024, pids: 256, tmpMb: 256 }, policy, uid: 1000, gid: 1000, maxWorkspaces: 4, previewPorts: [8000],
  })
  const repo = { fullName: 'local/origin', cloneUrl: `file://${origin}` }
  let a: WorkspaceRecord
  let b: WorkspaceRecord

  beforeAll(async () => {
    const seed = join(root, 'seed')
    execFileSync('git', ['init', '-q', '-b', 'main', seed])
    writeFileSync(join(seed, 'README.md'), '# seed\n')
    execFileSync('git', ['-C', seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'seed', '--allow-empty'])
    execFileSync('git', ['-C', seed, 'add', '.'])
    execFileSync('git', ['-C', seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'readme'])
    execFileSync('git', ['clone', '-q', '--bare', seed, origin])
    await docker.tryExec(['rm', '-f', UPSTREAM])
    // Leftovers of a crashed earlier run in this namespace; a running dsh-code's own are never named here.
    await docker.tryExec(['rm', '-f', manager.proxyContainer])
    await docker.tryExec(['network', 'rm', manager.internalNetwork, manager.egressNetwork])
    await manager.ensureNetwork()
    await docker.exec(['run', '-d', '--name', UPSTREAM, '--network', manager.egressNetwork, 'node:24-alpine', 'node', '-e',
      "require('http').createServer((q,s)=>s.end('upstream-ok')).listen(8080)"])
    a = await manager.provision('session-a', repo, 'main')
    b = await manager.provision('session-b', repo, 'main')
  }, 180_000)

  afterAll(async () => {
    await manager.delete('session-a').catch(() => undefined)
    await manager.delete('session-b').catch(() => undefined)
    await docker.tryExec(['rm', '-f', UPSTREAM])
    await docker.tryExec(['rm', '-f', manager.proxyContainer])
    await docker.tryExec(['network', 'rm', manager.internalNetwork, manager.egressNetwork])
    rmSync(root, { recursive: true, force: true })
  }, 120_000)

  it('passes the mandatory self test', async () => {
    const report = await manager.selfTest()
    expect(report.checks.filter(c => !c.ok)).toEqual([])
  }, 60_000)

  it('runs the worker under gVisor as a non-root user with the checkout mounted', async () => {
    expect(await manager.runInside(a, ['sh', '-c', 'dmesg | head -n 1'])).toMatch(/gVisor/)
    expect(await manager.runInside(a, ['id', '-u'])).toBe('1000')
    expect(await manager.runInside(a, ['cat', 'README.md'])).toBe('# seed')
    expect(await manager.runInside(a, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])).toBe(a.workingBranch)
    expect(a.workingBranch).not.toBe(b.workingBranch)
  }, 60_000)

  it('exposes no Docker socket, capabilities or writable root', async () => {
    expect(await manager.runInside(a, ['sh', '-c', 'test -e /var/run/docker.sock && echo present || echo absent'])).toBe('absent')
    expect(await manager.runInside(a, ['sh', '-c', 'grep CapEff /proc/self/status'])).toMatch(/0000000000000000/)
    expect(await manager.runInside(a, ['sh', '-c', 'touch /usr/x 2>/dev/null && echo writable || echo readonly'])).toBe('readonly')
  }, 60_000)

  it('keeps parallel sessions on separate filesystems', async () => {
    await manager.runInside(a, ['sh', '-c', 'echo from-a > only-a.txt'])
    expect(existsSync(join(a.path, 'only-a.txt'))).toBe(true)
    expect(await manager.runInside(b, ['sh', '-c', 'ls only-a.txt 2>/dev/null || echo missing'])).toBe('missing')
    expect(await manager.runInside(a, ['sh', '-c', `ls ${b.path} 2>/dev/null || echo missing`])).toBe('missing')
  }, 60_000)

  it('denies direct egress and admits only policy-approved destinations through the proxy', async () => {
    const direct = await manager.runInside(a, ['sh', '-c', 'curl -sS --noproxy "*" --max-time 5 http://1.1.1.1 >/dev/null 2>&1 && echo open || echo blocked'])
    expect(direct).toBe('blocked')
    const blocked = await manager.runInside(a, ['sh', '-c', 'curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://example.org/'])
    expect(blocked).toBe('403')
    const metadata = await manager.runInside(a, ['sh', '-c', 'curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://169.254.169.254/'])
    expect(metadata).toBe('403')
    const approved = await manager.runInside(a, ['sh', '-c', `curl -sS --max-time 10 http://${UPSTREAM}:8080/`])
    expect(approved).toBe('upstream-ok')
  }, 90_000)

  it('never returns a host file through the file helper while the sandbox swaps a symlink', async () => {
    const secret = join(root, 'host-secret.txt')
    writeFileSync(secret, 'host secret\n')
    await manager.runInside(a, ['sh', '-c', 'echo workspace > inside.txt'])
    await docker.exec(['exec', '-d', ...manager.execArgv(a, ['sh', '-c', `while true; do ln -sfn ${a.path}/inside.txt link; ln -sfn ${secret} link; done`], a.path, {}, false).slice(2)])
    const client = new FsHelperClient(['docker', ...manager.execArgv(a, ['node', FS_HELPER_PATH, a.path], a.path, {}, false)], a.path)
    const seen = new Set<string>()
    try {
      for (let i = 0; i < 1000; i++) {
        seen.add(await client.call({ op: 'readText', target: { targetKey: `${a.path}/link` as never, displayPath: 'link' } }).then(String, (e: { code: string }) => e.code))
      }
    } finally {
      client.close()
      await manager.runInside(a, ['sh', '-c', 'pkill -f "ln -sfn" || true; rm -f link'])
    }
    expect(seen.has('host secret\n')).toBe(false)
    expect(seen.has('workspace\n')).toBe(true)
  }, 180_000)

  it('reports resource usage and declared preview addresses', async () => {
    const usage = await manager.usage('session-a')
    expect(usage).toMatchObject({ pidsLimit: 256 })
    expect(usage!.memoryBytes).toBeGreaterThan(0)
    expect(usage!.diskBytes).toBeGreaterThan(0)
    expect((await manager.previewAddress('session-a', 8000)).host).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
    await expect(manager.previewAddress('session-a', 22)).rejects.toThrowError(/preview port/i)
  }, 60_000)

  it('refuses a destination as soon as the policy no longer allows it', async () => {
    await manager.updatePolicy({ ...policy, privateAllow: [] })
    await new Promise(r => setTimeout(r, 2500))
    const refused = await manager.runInside(a, ['sh', '-c', `curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://${UPSTREAM}:8080/`])
    expect(refused).toBe('403')
    await manager.updatePolicy(policy)
    await new Promise(r => setTimeout(r, 2500))
  }, 60_000)

  it('commits inside the sandbox and pushes only the session branch from the host mirror', async () => {
    await manager.runInside(a, ['sh', '-c', 'echo change >> README.md'])
    expect(await manager.pendingWork('session-a')).toMatchObject({ dirtyFiles: 2 })
    expect(await manager.diff('session-a')).toContain('+change')
    const pushed = await manager.commitAndPush('session-a', 'Code session change')
    expect(execFileSync('git', ['-C', origin, 'rev-parse', `refs/heads/${a.workingBranch}`]).toString().trim()).toBe(pushed.sha)
    expect(execFileSync('git', ['-C', origin, 'rev-parse', 'refs/heads/main']).toString().trim()).toBe(a.baseCommit)
  }, 90_000)

  it('does not run workspace-planted git hooks on the host when pushing', async () => {
    const marker = join(root, 'pwned')
    await manager.runInside(a, ['sh', '-c', `printf '#!/bin/sh\\ntouch ${marker}\\n' > .git/hooks/pre-push && chmod +x .git/hooks/pre-push && git config core.fsmonitor "touch ${marker}"`])
    await manager.runInside(a, ['sh', '-c', 'echo more >> README.md'])
    await manager.commitAndPush('session-a', 'second change')
    expect(existsSync(marker)).toBe(false)
  }, 90_000)

  it('stops the whole in-container process group a supervised exec started', async () => {
    await docker.exec(['exec', '-d', ...manager.execArgv(a, supervisedArgv('t1', ['sh', '-c', 'sleep 300 & sleep 301']), a.path, {}, false).slice(2)])
    await new Promise(r => setTimeout(r, 1000))
    // Only this test's two sleeps (the container's own `sleep infinity` keeps it alive).
    expect(await manager.runInside(a, ['sh', '-c', 'pgrep -fc "^sleep 30[01]$" || true'])).toBe('2')
    await manager.runInside(a, ['sh', '-c', 'p=$(cat /tmp/.dsh-exec/t1); kill -TERM -"$p"'])
    await new Promise(r => setTimeout(r, 1000))
    expect(await manager.runInside(a, ['sh', '-c', 'pgrep -fc "^sleep 30[01]$" || true'])).toBe('0')
  }, 60_000)

  it('reports the real exit code of a supervised command and stays attached while it runs', async () => {
    // Regression: setsid without --wait forks when it leads its process group, so docker exec returned 0 at once.
    const argv = (command: string): string[] => manager.execArgv(a, supervisedArgv('t2', ['sh', '-c', command]), a.path, {}, false).slice(2)
    expect((await docker.tryExec(['exec', ...argv('exit 3')])).code).toBe(3)
    const started = Date.now()
    expect((await docker.tryExec(['exec', ...argv('sleep 2')])).code).toBe(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900)
  }, 60_000)

  it('reconciles after a restart and cleans up everything it owns', async () => {
    const fresh = new WorkspaceManager(manager.config)
    const report = await fresh.reconcile()
    expect(report.offline).toEqual([])
    expect(fresh.get('session-b')?.status).toBe('ready')
    await fresh.delete('session-b')
    expect(await docker.inspect(b.containerName)).toBeUndefined()
    expect(existsSync(b.path)).toBe(false)
    expect(existsSync(b.mirrorPath)).toBe(false)
    expect(readFileSync(join(origin, 'HEAD'), 'utf8')).toContain('main')
  }, 90_000)
})
