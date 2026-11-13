import { describe, expect, it } from 'vitest'
import { containerEnv, supervisedArgv } from '../src/host/subprocess-docker.ts'

describe('docker subprocess helpers', () => {
  it('forwards only explicit, non-credential variables', () => {
    expect(containerEnv({ NO_COLOR: '1', GITHUB_TOKEN: 'x', OPENAI_API_KEY: 'y', DSH_WEB_URL: 'z', DOCKER_HOST: 'h', SSH_AUTH_SOCK: '/s', REMOVED: undefined, 'bad-name': 'v' }))
      .toEqual({ NO_COLOR: '1' })
    expect(containerEnv(undefined)).toEqual({})
  })

  it('runs the program as its own process group and records its id', () => {
    const argv = supervisedArgv('abc', ['bash', '-c', 'echo hi'])
    expect(argv.slice(0, 3)).toEqual(['setsid', '--wait', 'sh'])
    expect(argv[4]).toContain('/tmp/.dsh-exec/abc')
    expect(argv.slice(-3)).toEqual(['bash', '-c', 'echo hi'])
  })
})
