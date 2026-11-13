/**
 * Safety rules for the optional extra read-only folders of a Code workspace. A folder is mounted read-only at
 * the same path; these rules refuse paths whose contents would hand the sandbox credentials or host control.
 */
import { homedir } from 'node:os'

/** Directories under the home folder that hold credentials or agent state; never mounted. */
const HOME_SENSITIVE = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.config/gh', '.config/gcloud', '.azure', '.netrc', '.npmrc', '.pypirc', '.dsh', '.dsh-code', '.colima', '.claude', '.codex', 'Library/Keychains']
/** System roots that expose host control or secrets; neither they nor anything under them is mounted. */
const SYSTEM_SENSITIVE = ['/etc', '/private/etc', '/var/run', '/private/var/run', '/run', '/proc', '/sys', '/dev', '/var/lib/docker', '/boot', '/root', '/System']

const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`)

/**
 * Why a folder must not be mounted into a workspace, or undefined when it may.
 * @param path - absolute host path.
 * @param home - the host user's home folder.
 * @returns the refusal reason.
 */
export function unsafeFolderReason(path: string, home: string = homedir()): string | undefined {
  if (!path.startsWith('/') || path.includes('//') || path.split('/').some(part => part === '..' || part === '.') || (path.length > 1 && path.endsWith('/'))) {
    return 'must be an absolute, normalized path'
  }
  if (path === '/' || /^\/(home|root|Users)\/?[^/]*$/.test(path) || path === home) return 'a root or home folder is too broad'
  for (const root of SYSTEM_SENSITIVE) if (within(path, root)) return `${root} holds host secrets or controls`
  for (const relative of HOME_SENSITIVE) {
    const sensitive = `${home}/${relative}`
    if (within(path, sensitive) || within(sensitive, path)) return `it contains or is ${sensitive}`
  }
  if (/(^|\/)docker\.sock$/.test(path)) return 'the Docker socket controls the host'
  return undefined
}
