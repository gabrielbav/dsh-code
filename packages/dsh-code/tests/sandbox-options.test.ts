import { describe, expect, it } from 'vitest'
import { cacheEnvironment, CACHE_TARGET, createArgs, type ContainerSpec } from '../src/core/container-spec.ts'
import { environmentLines, parseEnvironment } from '../src/core/environment.ts'
import { unsafeFolderReason } from '../src/core/mounts.ts'

const home = '/Users/me'

describe('extra read-only folders', () => {
  it.each([
    '/', '/Users', '/Users/me', '/home/me', '/root', '/etc', '/etc/ssh', '/private/etc', '/var/run', '/var/run/docker.sock', '/proc/1',
    '/Users/me/.ssh', '/Users/me/.aws/config', '/Users/me/.config/gh', '/Users/me/.dsh', '/Users/me/.dsh-code/workspaces',
    'relative', '/Users/me/../me/.ssh', '/Users/me/work/', '/Users//me/work',
  ])('refuses %s', (path) => {
    expect(unsafeFolderReason(path, home)).toBeDefined()
  })

  it.each(['/Users/me/datasets', '/srv/shared/docs', '/opt/models'])('allows %s', (path) => {
    expect(unsafeFolderReason(path, home)).toBeUndefined()
  })

  it('refuses a folder that contains a credential folder', () => {
    expect(unsafeFolderReason('/Users/me/.config', home)).toMatch(/\.config\/gh|\.config\/gcloud/)
  })
})

describe('environment variables', () => {
  it('parses NAME=value lines; later names win; comments and blanks are ignored', () => {
    expect(parseEnvironment(['NODE_ENV=test', '', '# x', 'URL=http://a=b', 'NODE_ENV=development'])).toEqual({ NODE_ENV: 'development', URL: 'http://a=b' })
    expect(environmentLines({ A: '1', B: '' })).toEqual(['A=1', 'B='])
  })

  it.each([['API_KEY=x'], ['GITHUB_TOKEN=x'], ['DB_PASSWORD=x'], ['DSH_HOME=x'], ['DOCKER_HOST=x'], ['1BAD=x'], ['NO_EQUALS']])('refuses %s', (line) => {
    expect(() => parseEnvironment([line])).toThrow()
  })
})

describe('sandbox options in docker create', () => {
  const base: ContainerSpec = {
    name: 'dsh-code-w1', image: 'img', sessionId: 's', workspaceId: 'w1', workspacePath: '/srv/dsh-code/workspaces/w1',
    network: 'dsh-code-internal', proxyUrl: undefined, uid: 1000, gid: 1000, limits: { cpus: 1, memoryMb: 1024, pids: 128, tmpMb: 64 },
  }
  const mounts = (args: string[]): string[] => args.flatMap((a, i) => a === '--mount' ? [args[i + 1]!] : [])

  it('keeps a single read-write checkout mount by default', () => {
    expect(mounts(createArgs(base))).toEqual(['type=bind,source=/srv/dsh-code/workspaces/w1,target=/srv/dsh-code/workspaces/w1'])
  })

  it('mounts the checkout read-only, the cache and extra folders, and sizes /dev/shm', () => {
    const args = createArgs({ ...base, readOnlyWorkspace: true, cacheDir: '/srv/dsh-code/caches/acme__app', readOnlyFolders: ['/srv/datasets'], shmMb: 256 })
    expect(mounts(args)).toEqual([
      'type=bind,source=/srv/dsh-code/workspaces/w1,target=/srv/dsh-code/workspaces/w1,readonly',
      `type=bind,source=/srv/dsh-code/caches/acme__app,target=${CACHE_TARGET}`,
      'type=bind,source=/srv/datasets,target=/srv/datasets,readonly',
    ])
    expect(args.slice(args.indexOf('--shm-size'), args.indexOf('--shm-size') + 2)).toEqual(['--shm-size', '256m'])
    for (const [key, value] of Object.entries(cacheEnvironment())) expect(args).toContain(`${key}=${value}`)
  })

  it('refuses a folder that overlaps the checkout and an out-of-range /dev/shm', () => {
    expect(() => createArgs({ ...base, readOnlyFolders: ['/srv/dsh-code/workspaces'] })).toThrow(/read-only folder/)
    expect(() => createArgs({ ...base, readOnlyFolders: ['/srv/dsh-code/workspaces/w1/sub'] })).toThrow(/read-only folder/)
    expect(() => createArgs({ ...base, shmMb: 1 })).toThrow(/shared memory/)
  })
})
