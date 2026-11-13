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
| Container-backed `ctx.subprocess`, workspace-confined `ctx.fs`, `code` preset | `src/host/*`, `cordis.patch.yml` | real Web app run |
| Source control: repos, branches, pinned base, unique branch, diff, commit, push, PR, via host `gh` | `src/core/github.ts`, `src/core/git.ts` | live tests (push), real app (clone) |
| UI: Code mode in the mode selector, + menu Repository (grouped by gh account) and Branch, status line, Environment tab, Diff / Create PR / Restart / Delete | `src/client/*` | real Web app run |
| Per-session GitHub account: token passed to host `gh`/`git` only, stored in the workspace record | `src/core/github.ts`, `src/core/workspaces.ts` | real `gh` with four accounts |
| Code mode read from the Harness on every check (`agentPresets.composedPreset` / `presetForSession`), so it survives restarts | `CodeWorkspacesService.isCodeMode` | real Web app run |
| First message held until provisioned; working directory moved into the checkout | `CodeWorkspacesService.hold` | real Web app run |

The real-app run: fork built from source, this bundle packed and added with `dsh plugin --profile web add <tgz>`, mock model from `packages/test-support/llm-mock-server` scripting one `bash` call. The tool result showed `Starting gVisor`, `uid=1000`, the checkout path, the `dsh-code/...` branch, no Docker socket, and `example.org` blocked.

## Open work

Ordered by priority. Each item lists the goal, the approach, and how to verify it.

### 1. Close the confined-filesystem race (security)
- **Goal:** no host file outside the workspace can be read or written through the file tools, even when a container process swaps symlinks concurrently.
- **Approach:** run file operations inside the container. Either implement `ctx.fs` over `docker exec` with a small helper script per operation, or reuse `@deepseek-ai/dsh-ssh-helper-runtime`'s protocol over `docker exec -i`. Keep `ConfinedFileSystem` as the fallback check.
- **Verify:** a live test where a background container loop flips `link -> /etc/hostname` while the host reads `link` 1,000 times; the host must never return host content.

### 2. Settings > Code page
- **Goal:** edit network mode, allowlist, private destinations, resource limits and worker image from the UI (spec §4.1, §9).
- **Approach:** register into `settings.section`; persist through the `code-workspaces` row config via the existing settings/config-editor APIs; call `WorkspaceManager.updatePolicy` on change. Policy changes must never be callable from the agent's tools.
- **Verify:** change the allowlist in the UI and observe an open tunnel close and a new request refused.

### 3. Guided setup (spec §4.1)
- **Goal:** detect Docker and gVisor, offer install steps with consent, and build or pull the worker image.
- **Approach:** extend `setupStatus` with per-check remediation text; add `buildWorker()` that runs `docker build` from `worker/`; publish a pinned worker image by digest and verify it.
- **Verify:** on a host without `runsc`, the Code hero shows the failing checks and Code cannot start.

### 4. Publish
- **Goal:** install with `dsh plugin --profile web add @gabrielbav/dsh-code`.
- **Approach:** publish to npm (built `lib/` in `files`); set peer ranges to the Harness release that contains PR #2; add a CI workflow running `pnpm test`, `pnpm run typecheck`, and `pnpm run test:docker` on a runner with gVisor.

### 5. Process routing hardening
- **Goal:** cover every process a Code session can start.
- **Approach:** audit preset rows for direct `child_process` use (LSP if added, `tool-jobs` background jobs, persistent bash); verify background jobs run in the container; decide whether to start repository-defined MCP servers inside the container.
- **Verify:** a test per tool asserting its process runs under gVisor.

### 6. Subagents in Code sessions
- **Goal:** allow delegation without host execution.
- **Approach:** check whether `tool-subagent` spawn/fork children inherit the parent's preset and working directory; if so, re-enable `delegation` in the `code` preset; otherwise add an upstream generic option for child preset inheritance.

### 7. Resource usage view and previews
- **Goal:** spec CODE-14 and §9 application previews.
- **Approach:** `docker stats --no-stream` behind a Remote method and a right-sidebar tab; previews through an authenticated Harness route proxying a declared container port on the internal network, never a published host port.

### 8. macOS and Windows
- **Goal:** spec §8.2.
- **Approach:** Colima (macOS) and WSL2 (Windows) with `runsc` inside the VM.
- **Found on macOS (Colima 0.10, vz + virtiofs, runsc release-20261109.0):** the VM cannot read `~/Documents` (fixed: the proxy code is copied into `dataDir`); `/var/folders` temp dirs are not shared, so run `test:docker` with `TMPDIR` under `$HOME`; inside gVisor the shared checkout reads as owned by `0:0` while `runc` shows the host uid, so the sandbox user cannot write (`--directfs=false` and `--overlay2=none` do not change it). Next: try Colima `mountType: sshfs`.

### 9. Remote Control (spec §11, Phase 4)
- **Goal:** open and control a locally running Code session from an online Harness, without moving execution.
- **Approach:** build on experimental Liveshare (outbound tunnel, retry, per-principal RBAC). Missing: an owner-equivalent remote principal that may answer approvals, device pairing, replay across tunnel restarts, and the relay server. Most of this is generic and belongs upstream, as separate PRs.

### Out of scope for now
Team deployment (spec §12): Harness has no user/org model or managed worker hosts.

## Working in this repo

```sh
pnpm install
pnpm run build
pnpm test
pnpm run test:docker   # needs Docker with runsc and: docker build -t dsh-code-worker:0.1.0 packages/dsh-code/worker
```

To test inside Harness: build the fork from source (`pnpm run build:artifacts`), then `pnpm pack` this package and `dsh plugin --profile web add <tgz>` with a scratch `DSH_HOME`. Without a model key, run `pnpm run mock:llm` in the fork and start Harness with `DEEPSEEK_API_KEY=mock-key DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1`.
