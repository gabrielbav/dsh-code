import { describe, expect, it } from 'vitest'
import { onlySettingsChanged, validateSettings } from '../src/core/settings.ts'
import type { CodeSettings } from '../src/types.ts'

const good: CodeSettings = {
  network: 'allowlist', allow: ['GitHub.com', '*.npmjs.org', 'github.com'], privateAllow: ['Registry.local:5000'], ports: [443, 80, 443],
  cpus: 1.5, memoryMb: 2048, pids: 256, tmpMb: 512, maxWorkspaces: 4, workerImage: 'ghcr.io/acme/worker:1.0@sha256:' + 'a'.repeat(64), previewPorts: [5173, 3000],
  disabledAccounts: ['gvieiracit', 'gvieiracit'], newBranch: true,
  shmMb: 256, readOnlyWorkspace: false, dependencyCache: true, readOnlyFolders: ['/srv/datasets', '/srv/datasets'], environment: ['NODE_ENV=test', '# comment', 'NODE_ENV=development'], lockdown: false,
}

describe('Settings > Code validation', () => {
  it('normalizes valid settings', () => {
    expect(validateSettings(good)).toEqual({
      ...good, allow: ['github.com', '*.npmjs.org'], privateAllow: ['registry.local:5000'], ports: [80, 443], previewPorts: [3000, 5173],
      disabledAccounts: ['gvieiracit'],
      readOnlyFolders: ['/srv/datasets'], environment: ['NODE_ENV=development'],
    })
    expect(validateSettings({ ...good, workerImage: 'dsh-code-worker:0.2.0' }).workerImage).toBe('dsh-code-worker:0.2.0')
  })

  it.each([
    [{ network: 'sometimes' }, /network/],
    [{ allow: ['1.2.3.4'] }, /allow/],
    [{ allow: ['bad host'] }, /allow/],
    [{ allow: ['*'] }, /allow/],
    [{ privateAllow: ['10.0.0.1'] }, /privateAllow/],
    [{ ports: [0] }, /ports/],
    [{ cpus: 0 }, /cpus/],
    [{ memoryMb: 1.5 }, /memoryMb/],
    [{ pids: Number.NaN }, /pids/],
    [{ maxWorkspaces: 0 }, /maxWorkspaces/],
    [{ workerImage: 'evil image; rm -rf /' }, /workerImage/],
    [{ previewPorts: [70000] }, /previewPorts/],
    [{ disabledAccounts: ['not a login'] }, /disabledAccounts/],
    [{ disabledAccounts: 'gabrielbav' }, /disabledAccounts/],
    [{ newBranch: 'yes' }, /newBranch/],
    [{ shmMb: 8 }, /shmMb/],
    [{ lockdown: 'on' }, /lockdown/],
    [{ readOnlyFolders: ['/etc'] }, /readOnlyFolders/],
    [{ readOnlyFolders: ['relative/path'] }, /readOnlyFolders/],
    [{ environment: ['GITHUB_TOKEN=x'] }, /environment/],
    [{ environment: ['not a line'] }, /environment/],
  ] as const)('rejects %o', (patch, message) => {
    expect(() => validateSettings({ ...good, ...patch } as unknown as CodeSettings)).toThrowError(message)
  })

  it('applies live only when every non-settings field is unchanged', () => {
    const base = { dataDir: '/d', uid: 1000, network: 'allowlist', allow: ['a.com'] }
    expect(onlySettingsChanged(base, { ...base, network: 'none', allow: [] })).toBe(true)
    expect(onlySettingsChanged(base, { ...base, dataDir: '/e' })).toBe(false)
    expect(onlySettingsChanged(base, { ...base, uid: 0 })).toBe(false)
  })
})
