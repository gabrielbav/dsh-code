# dsh-code

Code mode for [DeepSeek Harness](https://github.com/gabrielbav/deepseek-harness): pick a repository and a branch, chat as usual, and every command and file edit the agent makes runs in an isolated Docker + gVisor workspace on its own branch.

Docs: [spec](https://github.com/gabrielbav/dsh-code/blob/main/docs/spec.md) · [validation and decisions](https://github.com/gabrielbav/dsh-code/blob/main/docs/validation.md) · [plan and open work](https://github.com/gabrielbav/dsh-code/blob/main/docs/plan.md)

## What you get

- **"Code mode" in the Harness mode selector**, in any Workspace you pick. The Workspace only groups the session in the sidebar: from the first message the session works in its own checkout. Switching to another mode before the first message drops the session's Code choices.
- **Repository and Branch in the composer's + menu** (also `/repository` and `/branch`), shown only on a Code mode session. Repository lists the repositories of every account the host's `gh` CLI is signed in with, grouped by account; the group you pick from is the account that clones, pushes and opens the pull request. The branch defaults to the repository's default branch. The row in use is marked "in use". A status line above the composer names the choice until the workspace is ready.
- **An Environment tab** beside Chat and Trajectory: GitHub account, repository, branches and commit, workspace status, network policy, sandbox options, live resource usage and the provisioning timeline (host paths, container names and images are not shown), plus this session's Preview options and variables.
- **A Preview tab**: the web app the agent starts in the workspace, found by the port it listens on. It reaches the app through `docker exec` (no route into the container, no host port), so it works on macOS, Windows and Linux. Two modes: a sandboxed frame in your browser (light, opaque origin, no logins), or the **isolated browser**, Chromium inside the sandbox streamed as frames, so page code never runs on your computer and apps with logins work. Both can be switched on or off in Settings and per session.
- **One gVisor container and one checkout per session.** The first message waits until the workspace is ready; follow-up messages reuse it. Parallel sessions never share a writable filesystem.
- **The normal chat.** Models, approvals, streaming, skills and history are Harness's own. The `code` agent preset only swaps where bash and the file tools execute.
- **Delete session** in the header: deletes the workspace, then the session (permanently with the session-delete plugin, otherwise archived); it warns about uncommitted or unpushed work first. A session deleted any other way loses its workspace too: a sweep removes workspaces whose session no longer exists. Remote branches and pull requests are never deleted.
- **The Harness permission selector applies.** Read-only makes the checkout read-only (the container restarts with a read-only mount when you switch); workspace-write is the default; full access never opens the sandbox: commands and files stay in the container and checkout.
- **Ask before a blocked host.** A blocked request answers `[sandbox: network access to <host> denied by the Code egress policy]`. The agent can then call `request_network_access` with the host and a reason, and the Harness approval card asks you. A host you allow is added for that one session only (the proxy recognizes the session's container by its internal address); other sessions and the shared allowlist stay as they are. The Environment tab lists the approved hosts with a Remove button. Nothing is granted when the network is off (or under Lockdown), when the session never asks for approval, or when you decline.
- **A stopped sandbox is not a failed command.** A health check every 10 seconds marks a workspace whose container stopped (VM restart, out of memory) as offline; commands then report `[sandbox: the Code workspace is offline]` instead of a misleading error, and the next message restarts it. Every sandbox refusal uses the same `[sandbox: ...]` form, so the agent reports it as policy rather than retrying.
- **Settings > Code:** network mode, approved host names and private destinations, ports, resource limits, workspaces per host, worker image and preview ports. Saved to the profile; network changes apply at once and close tunnels the new policy refuses.
- **Guided setup:** a Code mode session lists each failing check above the composer (Docker, runsc, worker image, gVisor probe, data folder, worker tools) with how to fix it, and can build the worker image on request. Code stays disabled until every check passes.
- **Subagents:** in-process spawn and fork children inherit the `code` preset, so they run in the same container and checkout.

## Requirements

- Linux with Docker Engine and the gVisor `runsc` runtime registered with Docker. There is no fallback to ordinary Docker: Code stays disabled and shows the failing checks until gVisor works.
- The GitHub CLI (`gh`) signed in on the host, with one or more accounts. Each Code session uses one of them: dsh-code reads that account's token with `gh auth token --user` and passes it as `GH_TOKEN` to the host `gh` and `git` processes of that session only, so the gh CLI's own active account is never used implicitly. No token enters a container. `defaultAccount` in the `code-workspaces` config picks the account a session starts with; empty uses the gh CLI's active account.
- DeepSeek Harness 0.2.2 or later. Code uses only documented extension points (agent presets, `conversation.view`, `conversation.input.dock`, `conversation.session.header.actions`, `ctx.commandUi`); no Harness changes are needed.
- The worker image (about 1.8 GB with headless Chromium for the isolated browser), built once after `pnpm run build` (the build produces `worker/fs-helper.js`, which the image needs). The "Build worker image" action in the setup notice runs the same build for you:

```sh
docker build -t dsh-code-worker:0.3.0 packages/dsh-code/worker
```

Register gVisor with Docker (Linux):

```sh
# install runsc and its gvisor-bin helpers from https://gvisor.dev/docs/user_guide/install/
echo '{"runtimes":{"runsc":{"path":"/usr/local/bin/runsc"}}}' | sudo tee /etc/docker/daemon.json
sudo systemctl reload docker
```

## Install

From npm, in the Web UI (**Settings > Plugins > Add plugin**, `@gabrielbav/dsh-code`) or from the CLI:

```sh
dsh plugin --profile web add @gabrielbav/dsh-code
```

Then choose **Code mode** in the mode selector. If a setup check fails, the notice above the composer says how to fix it; its **Build worker image** action builds `dsh-code-worker:0.3.0` from the Dockerfile shipped in the package.

From source, build and pack the bundle, then add the tarball to a profile:

```sh
pnpm install && pnpm run build
(cd packages/dsh-code && pnpm pack --pack-destination ../..)
dsh plugin --profile web add ./gabrielbav-dsh-code-0.2.0.tgz
```

The package declares a Harness bundle, so `dsh plugin add` appends it to the profile's bundle list. Restart `dsh web` if HMR is disabled. Its `@deepseek-ai/*` dependencies are peers satisfied by the running Harness.

## Configure

Use **Settings > Code**, or override the `code-workspaces` row in the profile's `cordis.patch.yml`:

```yaml
- id: code-workspaces
  config:
    dataDir: /var/lib/dsh-code      # workspaces, mirrors, records
    workerImage: dsh-code-worker:0.3.0
    cpus: 2
    memoryMb: 4096
    pids: 512
    tmpMb: 1024
    maxWorkspaces: 8
    network: allowlist              # allowlist | none | open
    allow: [github.com, '*.github.com', registry.npmjs.org, pypi.org]
    privateAllow: []                # explicit private destinations, as host:port
    ports: [80, 443]
    previewPorts: []                # container ports that may be previewed, e.g. [3000, 5173]
```

Settings > Code also has these sandbox options, all off or empty by default:

- **Lockdown**: no network, a read-only workspace, no dependency cache and no extra folders, whatever else is set.
- **Read-only workspace**: the agent can read and run code but cannot change files.
- **Dependency cache**: npm, yarn, pip, uv, Go, Cargo, Gradle and Bun caches kept between sessions, one per repository, under `dataDir/caches`.
- **Extra read-only folders**: mounted read-only at the same path in every workspace; refused and missing folders are skipped and shown in the provisioning timeline.
- **Shared memory**: `/dev/shm` size, 256 MB by default (headless browsers need more than Docker's 64 MB).
- **Environment variables**: defaults for every session in Settings, and per-session values in the Environment tab that override them by name. They apply from the agent's next command. Credential-like names are refused, because the agent can read every value.
- **Preview** (on by default) and **Isolated browser** (off by default; forced by Lockdown): each session can override both in its Environment tab. The isolated browser uses about 300–500 MB of memory per open preview.

Settings > Code edits every field above except `dataDir`; those changes apply without restarting Harness. `/tmp` size and image changes reach a workspace when it restarts.

`dataDir` defaults to `~/.dsh-code`, or to `/var/lib/dsh-code` when Harness runs as root: the container user must be able to enter it.

## Security model

| Control | How it is enforced |
| --- | --- |
| Runtime | Every workspace container is created with `--runtime runsc` and checked after start; the setup check confirms the container kernel is gVisor |
| Privileges | Non-root user, `--cap-drop ALL`, `no-new-privileges`, read-only root filesystem, tmpfs `/tmp`, CPU, memory and process limits |
| Docker socket and host files | Never mounted. By default the only bind mount is the session's own checkout, at the same path. Opt-in, off by default: a per-repository dependency cache (read-write, owned by the sandbox) and extra read-only folders; home roots, credential folders (`~/.ssh`, `~/.aws`, `~/.config/gh`, …), system folders, the Docker socket and the Code data folder are refused |
| Processes | The preset's `ctx.subprocess` runs every command through `docker exec` in the session's container and refuses any directory outside a ready Code workspace |
| File tools | The preset's `ctx.fs` runs every file operation inside the session's container, through a helper baked into the worker image (`/opt/dsh-code/fs-helper.js`, the Harness local backend bundled). Symlinks resolve in the container's mount namespace, so a link swapped by sandbox code cannot reach a host file. The host also refuses paths outside a ready workspace and checks every target the helper returns; watching polls inside the container |
| Search | ripgrep runs in the container; the host's ripgrep path is mapped to the image's `rg` |
| Prompt files | `CLAUDE.md`, `AGENTS.md` and skill folders in the checkout are read through the container fs, so a repository symlink to a host file (for example `~/.aws/credentials`) finds nothing instead of putting that file in the prompt |
| Checkout ownership | When Harness runs as root, a fresh clone is handed to the sandbox user with `lchown` for symlinks: a repository link to a host file never changes that file's owner |
| Previews | The Preview tab reaches the app through `docker exec`: a relay inside the container connects to `127.0.0.1:<port>`, so no host port is published and no route into the container exists. Frame mode loads `/dsh-code/preview/<token>/…` in a frame without `allow-same-origin`; responses carry `Content-Security-Policy: sandbox …; frame-ancestors 'self'`, Cookie and Authorization headers are never forwarded and Set-Cookie is dropped; tokens are minted only through the authenticated Code UI, bound to one session and port, and expire after 8 hours. Isolated mode runs Chromium inside the workspace (gVisor, no capabilities) and only JPEG frames leave it; the bridge accepts a fixed set of actions (http(s) navigation, clicks, keys, wheel, resize, history), never raw DevTools access |
| Network | Containers sit on an internal Docker network with no route out. A trusted egress proxy outside the worker admits only allowlisted host names, refuses direct IPs, IPv6, private, link-local and metadata addresses (also after DNS resolution), and closes tunnels a tightened policy no longer allows. DNS is resolved once and the checked address is dialed, so a rebinding name cannot switch targets; CGNAT, multicast and IPv4-mapped IPv6 are refused too. The proxy caps concurrent connections before doing any work, and tunnels close only when idle. The worker has no DNS, and the Harness web server (Settings, previews) is a private destination it cannot reach |
| Credentials | Model credentials stay in Harness on the host. Git clone and push run on the host through `gh`, with the GitHub account chosen for the session: its token is passed only to that session's host `gh` and `git` processes, never into a container. Variables whose names look like credentials are never forwarded into a container |
| Git | Once a container exists, the host never runs Git inside the sandbox-writable checkout (its config could name hooks, filters or fsmonitor commands). Status, diff and commit run inside the container; a push imports a Git bundle into a host-owned mirror and pushes only the session's `dsh-code/...` branch |
| Lifecycle | Logical session ids are distinct from container ids. Records survive restarts; startup removes orphaned containers and marks missing ones offline, and the next message restarts them |
| Integrity | If the Code preset fails to load, the dsh output says why instead of Code mode silently disappearing. Live tests run under their own Docker namespace and never touch a running install |

The `code` preset omits tools that would act from the host on the agent's behalf: out-of-process subagent providers (SDK, Claude Code, Codex, ACP), workflows, web fetch, office documents and plugin management. In-process subagents and web search remain. Skill folders and instruction files are read through the container fs and are not watched from the host.

## Known limitations

- **Previews** need `dsh web` (the desktop app has no web server), proxy plain HTTP only (no WebSocket, so no dev-server hot reload), and work best with relative asset paths: an app that requests `/assets/x.js` from the root reaches Harness, not the preview.
- **Settings > Code** cannot change `dataDir`; set it in `cordis.patch.yml`.
- **Host-configured MCP servers** are Harness-wide and run on the host as before. Repository-defined MCP servers are not started for Code sessions.
- **Repository listing** uses `gh api user/repos` for each signed-in account, in parallel; the listing is reused for 30 seconds. An account whose listing fails shows its error in its own group.
- **Choices before the first message live in memory.** The repository, branch and account picked for a blank session are lost if Harness restarts before the first message; the session stays in Code mode. A provisioned workspace is recorded under `dataDir`.
- **Linux is the supported host.** On macOS with Colima (virtiofs), the container sees the shared checkout as owned by root, so the sandbox user cannot write to it: reads and commands work, writes fail. The egress proxy's code is copied into `dataDir` because the VM cannot read `~/Documents`. Windows (WSL2) is untested.
- **Not implemented yet:** Remote Control and team deployment (see [plan](https://github.com/gabrielbav/dsh-code/blob/main/docs/plan.md)); a published, digest-pinned worker image (build it locally).

## Develop

```sh
pnpm install
pnpm run build        # tsc, Typert metadata, browser bundle, worker file helper
pnpm test             # unit tests
pnpm run test:docker  # live Docker + gVisor tests (needs runsc and the worker image)
```

The build uses only published packages: `@deepseek-ai/dsh-*@0.2.2-rc.1` for types and the Typert generator, patched (`patches/`) so it recognizes the npm-installed protocol package outside the Harness monorepo. `packages/dsh-code/tsdown.client.ts` emits the Harness client module format directly.

## Layout

```text
packages/dsh-code/
  src/core/      Docker CLI, container spec, workspace manager, host Git, GitHub CLI
  src/egress/    egress policy and proxy (runs in its own container)
  src/core/settings.ts  Settings > Code validation
  src/host/      Harness plugins: codeWorkspaces service, Docker subprocess, container fs, preview proxy
  src/worker/    in-container file helper and its wire protocol (bundled into worker/fs-helper.js)
  src/client/    Web UI: + menu rows, status line, Environment tab, session actions
  worker/        worker image Dockerfile
  cordis.patch.yml  bundle rows and the `code` preset
```
