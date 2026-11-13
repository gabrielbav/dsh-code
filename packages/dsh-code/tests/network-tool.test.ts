import { describe, expect, it } from 'vitest'
import { requestNetworkAccess, type Approver, type NetworkRequestInput } from '../src/host/network-tool.ts'
import type { EgressPolicy } from '../src/egress/policy.ts'

function harness(policy: Partial<EgressPolicy> = {}, answer: Awaited<ReturnType<Approver['request']>> = 'allowed-once', ask: 'ask' | 'never' = 'ask') {
  const granted: string[] = []
  const asked: string[] = []
  const grants: string[] = []
  const manager = {
    config: { policy: { mode: 'allowlist', allow: ['github.com'], privateAllow: [], ports: [80, 443], ...policy } as EgressPolicy },
    networkGrants: () => grants,
    grantNetwork: async (_s: string, host: string) => { granted.push(host); grants.push(host) },
    get: (id: string) => (id === 's1' ? {} : undefined),
  } as unknown as NetworkRequestInput['manager']
  const approver: Approver = {
    policyOf: () => ask,
    request: async (req) => { asked.push(req.displayReason?.en ?? ''); return answer },
  }
  const run = (host: string, sessionId = 's1', withApprover = true) => requestNetworkAccess({
    manager, approver: withApprover ? approver : undefined, agent: { id: sessionId, session: {} }, host, reason: 'install a package',
  })
  return { run, granted, asked }
}

describe('request_network_access', () => {
  it('asks the user and grants the exact host for this session only', async () => {
    const h = harness()
    expect((await h.run('https://registry.example.com/path')).outcome).toBe('granted')
    expect(h.granted).toEqual(['registry.example.com'])
    expect(h.asked[0]).toContain('registry.example.com')
    // A second request for the same host does not ask again.
    expect((await h.run('registry.example.com')).outcome).toBe('already-allowed')
    expect(h.asked).toHaveLength(1)
  })

  it('never grants without a yes', async () => {
    for (const answer of ['rejected', 'unavailable'] as const) {
      const h = harness({}, answer)
      expect((await h.run('evil.example')).outcome).toBe('declined')
      expect(h.granted).toEqual([])
    }
    const never = harness({}, 'allowed-once', 'never')
    expect((await never.run('evil.example')).outcome).toBe('not-asked')
    expect(never.asked).toEqual([])
    const missing = harness()
    expect((await missing.run('evil.example', 's1', false)).outcome).toBe('not-asked')
    expect(missing.granted).toEqual([])
  })

  it('refuses IPs, invalid names, network off and sessions without a workspace', async () => {
    const h = harness()
    for (const host of ['10.0.0.1', '169.254.169.254', 'localhost', 'bad host', '']) expect((await h.run(host)).outcome, host).toBe('invalid-host')
    expect((await harness({ mode: 'none' }).run('registry.example.com')).outcome).toBe('network-disabled')
    expect((await h.run('registry.example.com', 'other')).outcome).toBe('no-workspace')
    expect((await h.run('github.com')).outcome).toBe('already-allowed')
    expect(h.asked).toEqual([])
  })
})
