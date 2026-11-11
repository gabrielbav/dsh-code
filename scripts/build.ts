/**
 * Build every artifact of the dsh-code bundle: host JavaScript and
 * declarations (tsc), Typert Host/Remote metadata (the published generator),
 * the browser bundle in the Harness client module format, and the
 * in-container file helper copied into the worker image (tsdown).
 */
import { execFileSync } from 'node:child_process'
import { WorkspaceTypertGenerator, writeWorkspaceArtifacts } from '@deepseek-ai/dsh-typert-generator'

const root = new URL('..', import.meta.url).pathname
const run = (bin: string, args: string[], cwd = root): void => { execFileSync(bin, args, { cwd, stdio: 'inherit' }) }

// The client imports @gabrielbav/dsh-code/remote (lib/typert.remote-client.*), which only the host
// face generates. Emit the host face first so a clean checkout can compile and analyze the client.
run(`${root}node_modules/.bin/tsc`, ['-b', 'tsconfig.host.json'])
writeWorkspaceArtifacts(root, new WorkspaceTypertGenerator(root).generateContributors(['host']))
run(`${root}node_modules/.bin/tsc`, ['-b', 'tsconfig.client.json'])
writeWorkspaceArtifacts(root, new WorkspaceTypertGenerator(root).generateContributors())
run(`${root}packages/dsh-code/node_modules/.bin/tsdown`, ['-c', 'tsdown.client.ts'], `${root}packages/dsh-code`)
run(`${root}packages/dsh-code/node_modules/.bin/tsdown`, ['-c', 'tsdown.worker.ts'], `${root}packages/dsh-code`)
console.log('dsh-code: build complete')
