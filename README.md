# dsh-code

Code mode for [DeepSeek Harness](https://github.com/gabrielbav/deepseek-harness): pick a repository and a branch, chat as usual, and every command and file edit the agent makes runs in an isolated Docker + gVisor workspace on its own branch.

## What you get

- **A Chat | Code switch** at the top of the sidebar. Code mode lists only Code sessions; Chat mode hides them.
- **Repository and branch pickers** on a new Code session. The branch defaults to the repository's default branch.
- **One gVisor container and one checkout per session.** The first message waits until the workspace is ready; follow-up messages reuse it. Parallel sessions never share a writable filesystem.
- **The normal chat.** Models, approvals, streaming, skills and history are Harness's own. The `code` agent preset only swaps where bash and the file tools execute.
- **Session actions:** Diff against the pinned base commit, Create PR (commit, push the session branch, open the PR), Restart workspace, Delete workspace (warns about uncommitted or unpushed work first). Archiving a Code session also deletes its workspace. Remote branches and pull requests are never deleted.

## Requirements

- Linux with Docker Engine and the gVisor `runsc` runtime registered with Docker. There is no fallback to ordinary Docker: Code stays disabled and shows the failing checks until gVisor works.
- The GitHub CLI (`gh`) signed in on the host. It lists repositories and branches, and Git uses it as the credential helper for cloning and pushing. No token enters a container.
- DeepSeek Harness with the `sidebar.mode` slot and `uiWorkspace.registerSessionFilter` (gabrielbav/deepseek-harness PR #2). Without them, Code works but the switch and the sidebar filter are absent.
- The worker image, built once:

```sh
docker build -t dsh-code-worker:0.1.0 packages/dsh-code/worker
```

Register gVisor with Docker (Linux):

```sh
# install runsc and its gvisor-bin helpers from https://gvisor.dev/docs/user_guide/install/
echo '{"runtimes":{"runsc":{"path":"/usr/local/bin/runsc"}}}' | sudo tee /etc/docker/daemon.json
sudo systemctl reload docker
```

## Install

Build and pack the bundle, then add the tarball to a profile:

```sh
pnpm install && pnpm run build
(cd packages/dsh-code && pnpm pack --pack-destination ../..)
dsh plugin --profile web add ./gabrielbav-dsh-code-0.1.0.tgz
```

The package declares a Harness bundle, so `dsh plugin add` appends it to the profile's bundle list. Restart `dsh web` if HMR is disabled. Its `@deepseek-ai/*` dependencies are peers satisfied by the running Harness.

## Configure

Override the `code-workspaces` row in the profile's `cordis.patch.yml`:

```yaml
- id: code-workspaces
  config:
    dataDir: /var/lib/dsh-code      # workspaces, mirrors, records
    workerImage: dsh-code-worker:0.1.0
    cpus: 2
    memoryMb: 4096
    pids: 512
    tmpMb: 1024
    maxWorkspaces: 8
    network: allowlist              # allowlist | none | open
    allow: [github.com, '*.github.com', registry.npmjs.org, pypi.org]
    privateAllow: []                # explicit private destinations, as host:port
    ports: [80, 443]
```

`dataDir` defaults to `~/.dsh-code`, or to `/var/lib/dsh-code` when Harness runs as root: the container user must be able to enter it.

## Security model

| Control | How it is enforced |
| --- | --- |
| Runtime | Every workspace container is created with `--runtime runsc` and checked after start; the setup check confirms the container kernel is gVisor |
| Privileges | Non-root user, `--cap-drop ALL`, `no-new-privileges`, read-only root filesystem, tmpfs `/tmp`, CPU, memory and process limits |
| Docker socket and host files | Never mounted. The only bind mount is the session's own checkout, at the same path |
| Processes | The preset's `ctx.subprocess` runs every command through `docker exec` in the session's container and refuses any directory outside a ready Code workspace |
| File tools | The preset's `ctx.fs` admits only canonical paths (symlinks resolved) inside the session's own workspace, for reads and writes |
| Network | Containers sit on an internal Docker network with no route out. A trusted egress proxy outside the worker admits only allowlisted host names, refuses direct IPs, IPv6, private, link-local and metadata addresses (also after DNS resolution), and closes tunnels a tightened policy no longer allows. The worker has no DNS |
| Credentials | Model credentials stay in Harness on the host. Git clone and push run on the host through `gh`. Variables whose names look like credentials are never forwarded into a container |
| Git | Once a container exists, the host never runs Git inside the sandbox-writable checkout (its config could name hooks, filters or fsmonitor commands). Status, diff and commit run inside the container; a push imports a Git bundle into a host-owned mirror and pushes only the session's `dsh-code/...` branch |
| Lifecycle | Logical session ids are distinct from container ids. Records survive restarts; startup removes orphaned containers and marks missing ones offline, and the next message restarts them |

The `code` preset omits tools that would act from the host on the agent's behalf: subagent and workflow delegation (child agents do not inherit the preset), web fetch, office documents and plugin management. Web search remains.

## Known limitations

- **File-tool race.** The confined filesystem re-checks every path just before each host system call, but a process inside the container can still swap a symlink in between. The fix is to run file operations inside the container too.
- **Host-configured MCP servers** are Harness-wide and run on the host as before. Repository-defined MCP servers are not started for Code sessions.
- **Repository listing** uses `gh api user/repos`. When listing fails, the picker accepts a typed `owner/name`.
- **Linux only so far.** macOS (Colima) and Windows (WSL2) need gVisor inside the VM and are untested.
- **Not implemented yet:** a Settings > Code page (configuration goes through `cordis.patch.yml`), a resource usage view, authenticated application previews, Remote Control, and team deployment.

## Develop

```sh
pnpm install
pnpm run build        # tsc, Typert metadata, browser bundle
pnpm test             # unit tests
pnpm run test:docker  # live Docker + gVisor tests (needs runsc and the worker image)
```

The build uses only published packages: `@deepseek-ai/dsh-*@0.2.2-rc.1` for types and the Typert generator, patched (`patches/`) so it recognizes the npm-installed protocol package outside the Harness monorepo. `packages/dsh-code/tsdown.client.ts` emits the Harness client module format directly.

## Layout

```text
packages/dsh-code/
  src/core/      Docker CLI, container spec, workspace manager, host Git, GitHub CLI
  src/egress/    egress policy and proxy (runs in its own container)
  src/host/      Harness plugins: codeWorkspaces service, Docker subprocess, confined fs
  src/client/    Web UI: mode switch, pickers, status line, session actions
  worker/        worker image Dockerfile
  cordis.patch.yml  bundle rows and the `code` preset
```
