import { describe, expect, it } from 'vitest'
import { DEFAULT_ALLOW, decideAddress, decideRequest, isBlockedAddress, matchesPattern, type EgressPolicy } from '../src/egress/policy.ts'

const policy: EgressPolicy = { mode: 'allowlist', allow: DEFAULT_ALLOW, privateAllow: [], ports: [80, 443] }

describe('egress policy', () => {
  it('admits approved hosts and subdomains only', () => {
    expect(decideRequest(policy, 'github.com', 443).allowed).toBe(true)
    expect(decideRequest(policy, 'api.github.com', 443).allowed).toBe(true)
    expect(decideRequest(policy, 'GITHUB.COM.', 443).allowed).toBe(true)
    expect(decideRequest(policy, 'evilgithub.com', 443).allowed).toBe(false)
    expect(decideRequest(policy, 'github.com.evil.io', 443).allowed).toBe(false)
    expect(matchesPattern('github.com', '*.github.com')).toBe(false)
  })

  it('refuses direct IP literals, including IPv6', () => {
    expect(decideRequest(policy, '140.82.112.3', 443)).toMatchObject({ allowed: false })
    expect(decideRequest(policy, '[::1]', 443)).toMatchObject({ allowed: false })
    expect(decideRequest(policy, '169.254.169.254', 80)).toMatchObject({ allowed: false })
  })

  it('refuses other ports and invalid names', () => {
    expect(decideRequest(policy, 'github.com', 22).allowed).toBe(false)
    expect(decideRequest(policy, 'bad_host!', 443).allowed).toBe(false)
  })

  it('honours none and open modes', () => {
    expect(decideRequest({ ...policy, mode: 'none' }, 'github.com', 443).allowed).toBe(false)
    expect(decideRequest({ ...policy, mode: 'open' }, 'example.org', 443).allowed).toBe(true)
  })

  it('classifies private, metadata and IPv6 addresses as blocked', () => {
    for (const a of ['10.1.2.3', '127.0.0.1', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '0.0.0.0', '::1', 'fd00::1', '2606:4700::1111', '::ffff:10.0.0.1']) {
      expect(isBlockedAddress(a), a).toBe(true)
    }
    for (const a of ['140.82.112.3', '104.16.0.1', '::ffff:140.82.112.3']) expect(isBlockedAddress(a), a).toBe(false)
  })

  it('blocks DNS rebinding to private ranges unless explicitly approved', () => {
    expect(decideAddress(policy, 'github.com', 443, '10.0.0.5').allowed).toBe(false)
    expect(decideAddress({ ...policy, privateAllow: ['git.internal:443'] }, 'git.internal', 443, '10.0.0.5').allowed).toBe(true)
  })

  it('admits explicitly approved private destinations', () => {
    const approved = { ...policy, privateAllow: ['10.0.0.5:5432'] }
    expect(decideRequest(approved, '10.0.0.5', 5432).allowed).toBe(true)
  })
})
