# Plan and continuation spec

Status of [spec.md](spec.md) as implemented in this repository, and the open work, each item written so a new session can pick it up without this history. Architecture decisions are in [validation.md](validation.md).

## Repositories

- **gabrielbav/dsh-code (this repo):** all Code plugin code, docs and tests.
- **gabrielbav/deepseek-harness:** upstream-only, generic changes. Code no longer needs any: the mode selector replaced the `sidebar.mode` switch and session filter of PR #3 (formerly #2). Nothing Code-specific goes there.

## Done

| Spec area | Where | Evidence |
|---|---|---|
| Docker + gVisor runtime, no fallback, self test | `src/core/workspaces.ts` `selfTest` | live tests |
| Security defaults (non-root, cap-drop, no-new-privileges, read-only root, limits, no socket, single bind mount) | `src/core/container-spec.ts` | unit + live tests |
| One container, checkout and branch per session; parallel isolation | `WorkspaceManager.provision` | live tests |
| Lifecycle: records, reconcile, restart, delete, archive cleanup | `WorkspaceManager`, `workspaces-service.ts` | live tests |
| Egress: allowlist, no direct IP/IPv6/private/metadata, DNS rebinding, policy reload closes tunnels, no worker DNS | `src/egress/*` | unit + live tests |
| Container-backed `ctx.subprocess`, container-backed `ctx.fs`, `code` preset | `src/host/*`, `src/worker/*`, `cordis.patch.yml` | unit tests; race check (below) |
| Source control: repos, branches, pinned base, unique branch, diff, commit, push, PR, via host `gh` | `src/core/github.ts`, `src/core/git.ts` | live tests (push), real app (clone) |
| UI: Code mode in the mode selector, + menu Repository (grouped by gh account) and Branch, status line, Environment tab, Diff / Create PR / Resources / Preview / Restart / Delete, Settings > Code, guided setup above the composer | `src/client/*` | real Web app run (Code mode, + menu, accounts, Environment); typecheck + build (Settings, Resources, Preview) |
| Per-session GitHub account: token passed to host `gh`/`git` only, stored in the workspace record | `src/core/github.ts`, `src/core/workspaces.ts` | real `gh` with four accounts |
| Code mode read from the Harness on every check (`agentPresets.composedPreset` / `presetForSession`), so it survives restarts | `CodeWorkspacesService.isCodeMode` | real Web app run |
| First message held until provisioned; working directory moved into the checkout | `CodeWorkspacesService.hold` | real Web app run |
| File operations run inside the container (closes the symlink race) | `src/host/fs-container.ts`, `src/host/fs-helper-client.ts`, `src/worker/*`, `tsdown.worker.ts` | unit tests; manual race run below; live race test written, not yet run |
| Settings > Code page, saved through `ctx.configEditor`, applied in place via `internal/update` | `src/core/settings.ts`, `CodeWorkspacesService.updateSettings`, `CodeSettingsSection` | unit tests (validation, live-vs-restart) |
| Guided setup: per-check remediation, image check, Build worker image | `WorkspaceManager.selfTest`, `buildWorker` | unit tests (fake Docker) |
| Search, skills and subagents in Code sessions | `containerArgv` (ripgrep), preset rows | unit tests; preset rows unverified in a running Harness |
| Resource usage (`docker stats` + checkout size) | `WorkspaceManager.usage`, Resources dialog | unit tests (parsing); live test written, not yet run |
| Application previews through an authenticated, sandboxed route | `src/host/preview.ts`, `previewAddress`, Preview dialog | unit tests (headers, tokens, redirects); live test (address) written, not yet run |
| CI and publish prep | `.github/workflows/ci.yml`, `prepack`, `publishConfig` | not yet run on GitHub |

The real-app run (0.1.0): fork built from source, this bundle packed and added with `dsh plugin --profile web add <tgz>`, mock model from `packages/test-support/llm-mock-server` scripting one `bash` call. The tool result showed `Starting gVisor`, `uid=1000`, the checkout path, the `dsh-code/...` branch, no Docker socket, and `example.org` blocked.

Race check (0.2.0): a container (default runtime, otherwise the workspace flags) looped `ln -sfn` between a workspace file and a host-only file while the host read the link 1,000 times through the in-container helper: 585 workspace reads, 413 not found, 2 I/O errors, never the host file. The same run caught a bundling bug (a dependency read its own `package.json` at load), now fixed and covered by a unit test that runs the bundle without `node_modules`.

## Not verified in this round

The 0.2.0 session had Docker but no gVisor (`runsc` could not be installed there), so `pnpm run test:docker` was not run, and Harness itself was not started. Before relying on 0.2.0:

1. Run `pnpm run test:docker` on a host with `runsc` (or let the CI `docker-gvisor` job run). New live cases: the file-helper race, resource usage and preview address, and a policy update refusing a destination.
2. Start the Web app with the bundle and check: the Settings > Code page loads and saves (and the `code-workspaces` row changes in `cordis.patch.yml` without a plugin restart); the `subagent` tool appears in a Code session and its child runs `id -u` inside the same container; `grep`/search tools work; Resources and Preview open.

## Open work

Ordered by priority. Each item lists the goal, the approach, and how to verify it.

### 1. Publish
- **Goal:** install with `dsh plugin --profile web add @gabrielbav/dsh-code`.
- **Approach:** set peer ranges to the Harness releases Code is tested with (no fork PR is needed); publish the package to npm (`prepack` refuses an unbuilt tree); publish the worker image to a registry and pin `workerImage` by digest; add the npm and image publish steps to CI on tags.

### 2. Preview upgrades
- **Goal:** dev servers with hot reload.
- **Approach:** `ctx.webServer.registerUpgrade` matches exact paths only; either register one upgrade path per minted token or propose a generic prefix-upgrade option upstream. Serving previews from a separate origin (a second listener or subdomain) would also lift the relative-path limitation.

### 3. Process routing hardening
- **Goal:** cover every process a Code session can start.
- **Approach:** if `tool-jobs`/`jobs-local` are added to the preset, background jobs already run through `ctx.shell` → `ctx.subprocess`; add them and a live test. Decide whether to start repository-defined MCP servers inside the container (`ctx.subprocess` stdio). LSP (`lsp-stdio`) also spawns through `ctx.subprocess`; adding it needs the language servers in the worker image.

### 4. macOS and Windows
- **Goal:** spec §8.2.
- **Approach:** Colima (macOS) and WSL2 (Windows) with `runsc` inside the VM; the checkout must have the same absolute path in the VM and in the container.
- **Found on macOS (Colima 0.10, vz + virtiofs, runsc release-20261109.0):** the VM cannot read `~/Documents` (fixed: the proxy code is copied into `dataDir`); `/var/folders` temp dirs are not shared, so run `test:docker` with `TMPDIR` under `$HOME`; inside gVisor the shared checkout reads as owned by `0:0` while `runc` shows the host uid, so the sandbox user cannot write (`--directfs=false` and `--overlay2=none` do not change it). Next: try Colima `mountType: sshfs`.

### 5. Remote Control (spec §11, Phase 4)
- **Goal:** open and control a locally running Code session from an online Harness, without moving execution.
- **Approach:** build on experimental Liveshare (outbound tunnel, retry, per-principal RBAC). Missing: an owner-equivalent remote principal that may answer approvals, device pairing, replay across tunnel restarts, and the relay server. Most of this is generic and belongs upstream, as separate PRs.

### Out of scope for now
Team deployment (spec §12): Harness has no user/org model or managed worker hosts.

## Working in this repo

```sh
pnpm install
pnpm run build
pnpm test
pnpm run test:docker   # needs Docker with runsc and, after the build: docker build -t dsh-code-worker:0.2.0 packages/dsh-code/worker
```

To test inside Harness: build the fork from source (`pnpm run build:artifacts`), then `pnpm pack` this package and `dsh plugin --profile web add <tgz>` with a scratch `DSH_HOME`. Without a model key, run `pnpm run mock:llm` in the fork and start Harness with `DEEPSEEK_API_KEY=mock-key DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1`.
