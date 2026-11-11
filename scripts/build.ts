/**
 * Build every artifact of the dsh-code bundle: host JavaScript and
 * declarations (tsc), Typert Host/Remote metadata (the published generator),
 * and the browser bundle in the Harness client module format (tsdown).
 */
import { execFileSync } from 'node:child_process'
import { WorkspaceTypertGenerator, writeWorkspaceArtifacts } from '@deepseek-ai/dsh-typert-generator'

const root = new URL('..', import.meta.url).pathname
const run = (bin: string, args: string[], cwd = root): void => { execFileSync(bin, args, { cwd, stdio: 'inherit' }) }

run(`${root}node_modules/.bin/tsc`, ['-b', 'tsconfig.host.json', 'tsconfig.client.json'])
writeWorkspaceArtifacts(root, new WorkspaceTypertGenerator(root).generateContributors())
run(`${root}packages/dsh-code/node_modules/.bin/tsdown`, ['-c', 'tsdown.client.ts'], `${root}packages/dsh-code`)
console.log('dsh-code: build complete')
