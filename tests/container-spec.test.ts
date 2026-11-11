import { describe, expect, it } from 'vitest'
import { createArgs, execArgs, type ContainerSpec } from '../src/core/container-spec.ts'

const spec: ContainerSpec = {
  name: 'dsh-code-abc', image: 'node:24-alpine', sessionId: 's1', workspaceId: 'w1',
  workspacePath: '/srv/dsh-code/workspaces/w1', network: 'dsh-code-internal', proxyUrl: 'http://dsh-code-egress:3128',
  uid: 1000, gid: 1000, limits: { cpus: 2, memoryMb: 4096, pids: 512, tmpMb: 1024 },
}

describe('container spec', () => {
  it('pins gVisor and the security defaults', () => {
    const args = createArgs(spec)
    const pairs = (flag: string) => args.flatMap((a, i) => a === flag ? [args[i + 1]] : [])
    expect(pairs('--runtime')).toEqual(['runsc'])
    expect(pairs('--cap-drop')).toEqual(['ALL'])
    expect(pairs('--security-opt')).toContain('no-new-privileges')
    expect(args).toContain('--read-only')
    expect(pairs('--pids-limit')).toEqual(['512'])
    expect(pairs('--dns')).toEqual(['127.0.0.1'])
    expect(pairs('--mount')).toEqual(['type=bind,source=/srv/dsh-code/workspaces/w1,target=/srv/dsh-code/workspaces/w1'])
    expect(args.join(' ')).not.toMatch(/docker\.sock|--privileged/)
    expect(pairs('--env')).toContain('HTTPS_PROXY=http://dsh-code-egress:3128')
  })

  it('refuses root, home mounts, traversal and credential-like env', () => {
    expect(() => createArgs({ ...spec, uid: 0 })).toThrow(/root/)
    expect(() => createArgs({ ...spec, workspacePath: '/home/alice' })).toThrow(/home/)
    expect(() => createArgs({ ...spec, workspacePath: '/srv/../etc' })).toThrow(/normalized/)
    expect(() => createArgs({ ...spec, env: { GITHUB_TOKEN: 'x' } })).toThrow(/credential/)
    expect(() => createArgs({ ...spec, limits: { ...spec.limits, pids: 0 } })).toThrow(/pids/)
  })

  it('builds exec argv with cwd, env and optional tty', () => {
    expect(execArgs('c', ['bash', '-lc', 'ls'], '/w', { A: '1' }, false)).toEqual(['exec', '-i', '-w', '/w', '-e', 'A=1', 'c', 'bash', '-lc', 'ls'])
    expect(execArgs('c', ['sh'], '/w', {}, true).slice(0, 3)).toEqual(['exec', '-i', '-t'])
    expect(() => execArgs('c', [], '/w', {}, false)).toThrow()
  })
})
