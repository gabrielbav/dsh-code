/**
 * Root-only regression: giving a cloned checkout to the sandbox user must not follow a repository symlink to a
 * host file. Runs dsh-code's own chownTree as root inside a throwaway Linux container (never on the host).
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const enabled = process.env.DSH_CODE_DOCKER_TESTS === '1'

describe.skipIf(!enabled)('chownTree as root', () => {
  it('changes a symlink, never the host file it points to', () => {
    // Under $HOME so a Colima VM can see it; the built core modules import only Node built-ins. Run `pnpm run build` first.
    const work = mkdtempSync(join(homedir(), '.dsh-code-chown-'))
    try {
      cpSync(resolve(import.meta.dirname, '../../lib'), join(work, 'lib'), { recursive: true })
      const script = [
        "const { chownTree } = await import('/w/lib/core/workspaces.js')",
        "const fs = await import('node:fs')",
        "fs.writeFileSync('/host-secret', 'x'); fs.chownSync('/host-secret', 0, 0)",
        "fs.mkdirSync('/checkout'); fs.writeFileSync('/checkout/README.md', 'r')",
        "fs.symlinkSync('/host-secret', '/checkout/evil')",
        'await chownTree(\'/checkout\', 1000, 1000)',
        "console.log(JSON.stringify({ target: fs.statSync('/host-secret').uid, link: fs.lstatSync('/checkout/evil').uid, file: fs.statSync('/checkout/README.md').uid }))",
      ].join('; ')
      const out = execFileSync('docker', ['run', '--rm', '--user', '0:0', '--network', 'none', '-v', `${work}:/w:ro`, 'node:24-alpine',
        'node', '--input-type=module', '-e', script], { encoding: 'utf8' })
      expect(JSON.parse(out.trim().split('\n').pop()!)).toEqual({ target: 0, link: 1000, file: 1000 })
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }, 120_000)
})
