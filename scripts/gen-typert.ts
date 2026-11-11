/** Generate Typert Host/Remote artifacts for every package in this repository. */
import { WorkspaceTypertGenerator, writeWorkspaceArtifacts } from '@deepseek-ai/dsh-typert-generator'

const root = new URL('..', import.meta.url).pathname
const generator = new WorkspaceTypertGenerator(root)
const artifacts = generator.generateContributors()
writeWorkspaceArtifacts(root, artifacts)
for (const artifact of artifacts) console.log(`typert: ${JSON.stringify(Object.keys(artifact))}`)
