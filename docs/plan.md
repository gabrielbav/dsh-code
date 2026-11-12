# Plan and continuation spec

Status of [spec.md](spec.md) as implemented in this repository, and the open work, each item written so a new session can pick it up without this history. Architecture decisions are in [validation.md](validation.md).

## Repositories

- **gabrielbav/dsh-code (this repo):** all Code plugin code, docs and tests.
- **gabrielbav/deepseek-harness:** upstream-only, generic changes. PR #2 (`ccr-93d95a6e-jccvo1`) adds the `sidebar.mode` slot and `uiWorkspace.registerSessionFilter`. Nothing Code-specific goes there.

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
| UI: Chat/Code switch, sidebar filter, repo/branch pickers, status line, Diff / Create PR / Restart / Delete | `src/client/*` | real Web app run, screenshots |
| First message held until provisioned; working directory moved into the checkout | `CodeWorkspacesService.hold` | real Web app run |

The real-app run: fork built from source, this bundle packed and added with `dsh plugin --profile web add <tgz>`, mock model from `packages/test-support/llm-mock-server` scripting one `bash` call. The tool result showed `Starting gVisor`, `uid=1000`, the checkout path, the `dsh-code/...` branch, no Docker socket, and `example.org` blocked.

## Open work

Ordered by priority. Items 1 to 7 make Code safe and controllable on a self-hosted Linux host, where the operator decides per repository what each sandbox may reach. Each item lists the goal, the approach, and how to verify it.

### 1. Close the confined-filesystem race (security)
- **Goal:** no host file outside the workspace can be read or written through the file tools, even when a container process swaps symlinks concurrently. Required before running on a shared server.
- **Approach:** run file operations inside the container. Either implement `ctx.fs` over `docker exec` with a small helper script per operation, or reuse `@deepseek-ai/dsh-ssh-helper-runtime`'s protocol over `docker exec -i`. Keep `ConfinedFileSystem` as the fallback check.
- **Verify:** a live test where a background container loop flips `link -> /etc/hostname` while the host reads `link` 1,000 times; the host must never return host content.

### 2. Environment profiles
- **Goal:** the operator defines named environments (for example `default`, `offline`, `internal-registry`) and each Code session runs under exactly one. Today `network`, `allow`, `privateAllow`, `ports`, `workerImage` and the resource limits are one global set in the `code-workspaces` config.
- **Approach:**
  - Add `environments: Record<name, { network, allow, privateAllow, ports, workerImage, cpus, memoryMb, pids, tmpMb, env, setup }>` and `defaultEnvironment` to `Config`; keep the current top-level fields as the `default` profile. `env` keeps the existing credential-name refusal in `container-spec.ts`.
  - Add `repositoryEnvironments: { pattern: 'owner/name' | 'owner/*', environment }[]` so the operator, not the user or agent, maps repositories to environments. The repository picker shows the resolved environment; a user may choose only among environments the mapping allows.
  - Store the environment name in `WorkspaceRecord`; it is fixed for the session, like the base commit.
  - Per-environment egress: the proxy currently loads one `policy.json`. Either give each environment its own internal network and proxy container (simplest isolation; `ensureNetwork` takes the profile), or keep one proxy and select the policy by the client's internal address recorded at container creation. Prefer one network and proxy per environment: no address-to-session table to keep in sync.
- **Verify:** two sessions on different environments: one reaches `registry.npmjs.org`, the other is refused; a repository with no mapping uses `defaultEnvironment`; an unknown environment name fails at load.

### 3. Settings > Code page and live policy changes
- **Goal:** edit environments, repository mappings, network policy, private destinations, resource limits and worker image from the UI, with changes applied without restarting Harness (spec §4.1, §9).
- **Approach:** register into `settings.section`; persist through the `code-workspaces` row config via the existing settings/config-editor APIs. On change, call `WorkspaceManager.updatePolicy` for each affected environment (it exists but nothing calls it yet), so the proxy reloads and closes tunnels the new policy refuses. Limit and image changes apply on the next workspace restart; the UI says so. Policy changes are control-plane operations and must never be reachable from the agent's tools.
- **Verify:** change an environment's allowlist in the UI and observe an open tunnel close and a new request refused, without a restart; confirm no tool in the `code` preset can call the settings API.

### 4. Credential gateway
- **Goal:** let an environment grant access to specific authenticated services (private package registry, internal API) without any credential entering a container (spec §10.2).
- **Approach:** add per-environment `grants: { host, port, credentialRef }[]`, where `credentialRef` names a secret held by Harness credentials on the host. The egress proxy, outside the worker, terminates TLS only for granted hosts using a per-environment CA installed in the worker image's trust store, injects the `Authorization` header, and re-encrypts upstream. All other hosts stay plain `CONNECT` tunnels. Redact injected values from proxy logs. Revoking a grant or removing a secret takes effect on the next request.
- **Verify:** a live test where the worker fetches from a mock authenticated registry through a grant; `env`, `/proc` and the filesystem inside the container never contain the secret; removing the grant makes the next request fail.

### 5. Process routing hardening
- **Goal:** cover every process a Code session can start, so nothing configured for a session runs on the host.
- **Approach:** audit preset rows for direct `child_process` use (LSP if added, `tool-jobs` background jobs, persistent bash); verify background jobs run in the container; decide whether to start repository-defined MCP servers inside the container under the session's environment. Host-configured MCP servers stay on the host and are listed in the environment view so the operator sees them.
- **Verify:** a test per tool asserting its process runs under gVisor.

### 6. Guided setup, worker images and setup scripts
- **Goal:** detect Docker and gVisor, offer install steps with consent, and build, pin and verify worker images, including per-environment setup (spec §4.1, §8.3).
- **Approach:** extend `setupStatus` with per-check remediation text; add `buildWorker(environment)` that runs `docker build` from `worker/` with the environment's `setup` script as a build step, so dependency installation happens at image build time with the build's own network, never inside a running session. Record and require the image digest (`image@sha256:...`) in the environment; refuse a tag without a digest outside development.
- **Verify:** on a host without `runsc`, the Code hero shows the failing checks and Code cannot start; an environment with a changed `setup` script gets a new digest; a mismatched digest blocks provisioning.

### 7. Self-hosted server deployment
- **Goal:** run Harness with Code on a dedicated Linux server that the owner reaches from a browser, with documented operation.
- **Approach:**
  - Document a reference deployment: a service user, `dataDir` under `/var/lib/dsh-code`, a systemd unit for `dsh web`, Docker with `runsc` as the only runtime used by Code, and an authenticating reverse proxy (TLS plus SSO or basic auth) in front of `dsh web`, which must not listen on a public interface.
  - The host's single `gh` login is the GitHub identity of every session. Document it, and support a GitHub App installation token scoped to the selected repositories as an alternative to a personal login.
  - Add an audit log of policy changes and refused egress requests per environment and session (spec §17).
  - Multi-user access (per-user identity, permissions and isolation) stays out of scope until Harness has a user model (spec §12); the deployment is single-owner.
- **Verify:** follow the guide on a clean Linux VM; Code passes its setup checks; the Web UI is unreachable without authentication; the audit log records a refused request.

### 8. Publish
- **Goal:** install with `dsh plugin --profile web add @gabrielbav/dsh-code`.
- **Approach:** publish to npm (built `lib/` in `files`); set peer ranges to the Harness release that contains PR #2; add a CI workflow running `pnpm test`, `pnpm run typecheck`, and `pnpm run test:docker` on a runner with gVisor.

### 9. Subagents in Code sessions
- **Goal:** allow delegation without host execution.
- **Approach:** check whether `tool-subagent` spawn/fork children inherit the parent's preset and working directory; if so, re-enable `delegation` in the `code` preset; otherwise add an upstream generic option for child preset inheritance.

### 10. Resource usage view and previews
- **Goal:** spec CODE-14 and §9 application previews.
- **Approach:** `docker stats --no-stream` behind a Remote method and a right-sidebar tab; previews through an authenticated Harness route proxying a declared container port on the internal network, never a published host port. On a self-hosted server, previews go through the same authenticating reverse proxy as the Web UI.

### 11. macOS and Windows
- **Goal:** spec §8.2.
- **Approach:** Colima (macOS) and WSL2 (Windows) with `runsc` inside the VM; check the bind-mount path mapping and the container user's access to `dataDir`.

### 12. Remote Control (spec §11, Phase 4)
- **Goal:** open and control a locally running Code session from an online Harness, without moving execution.
- **Approach:** build on experimental Liveshare (outbound tunnel, retry, per-principal RBAC). Missing: an owner-equivalent remote principal that may answer approvals, device pairing, replay across tunnel restarts, and the relay server. Most of this is generic and belongs upstream, as separate PRs.

### Out of scope for now
Team deployment (spec §12): Harness has no user/org model or managed worker hosts. Single-owner self-hosting is item 7.

## Working in this repo

```sh
pnpm install
pnpm run build
pnpm test
pnpm run test:docker   # needs Docker with runsc and: docker build -t dsh-code-worker:0.1.0 packages/dsh-code/worker
```

To test inside Harness: build the fork from source (`pnpm run build:artifacts`), then `pnpm pack` this package and `dsh plugin --profile web add <tgz>` with a scratch `DSH_HOME`. Without a model key, run `pnpm run mock:llm` in the fork and start Harness with `DEEPSEEK_API_KEY=mock-key DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1`.
