import { describe, expect, it } from 'vitest'
import { workingBranchName } from '../src/core/git.ts'

describe('working branch names', () => {
  it('names each session branch dsh-code/<12 hex>', () => {
    expect(workingBranchName()).toMatch(/^dsh-code\/[0-9a-f]{12}$/)
    expect(workingBranchName(() => 'abc123def456')).toBe('dsh-code/abc123def456')
    expect(workingBranchName()).not.toBe(workingBranchName())
  })
})
