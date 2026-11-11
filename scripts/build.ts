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

// Host first: the client imports the Typert Remote declarations generated from it.
run(`${root}node_modules/.bin/tsc`, ['-b', 'tsconfig.host.json'])
const generator = new WorkspaceTypertGenerator(root)
writeWorkspaceArtifacts(root, generator.generateContributors(['host']))
writeWorkspaceArtifacts(root, generator.generateContributors())
run(`${root}node_modules/.bin/tsc`, ['-b', 'tsconfig.client.json'])
run(`${root}packages/dsh-code/node_modules/.bin/tsdown`, ['-c', 'tsdown.client.ts'], `${root}packages/dsh-code`)
run(`${root}packages/dsh-code/node_modules/.bin/tsdown`, ['-c', 'tsdown.worker.ts'], `${root}packages/dsh-code`)
console.log('dsh-code: build complete')
