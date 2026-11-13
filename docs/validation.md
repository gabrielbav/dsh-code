# Spec validation against the DeepSeek Harness fork

Phase 0 assessment of [spec.md](spec.md) against gabrielbav/deepseek-harness at `e8f7b93a3` (0.2.2-rc.2). It records the architecture decisions that diverge from the spec and why.

## Decisions

1. **Harness stays on the host; only execution moves into the container.** The spec put a full Harness worker in each container. The fork's own design (`.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.md`) calls that a separate deployment model: it moves model credentials and session storage into the sandbox and disconnects the session from the Web chat. Instead, the `code` agent preset replaces `ctx.subprocess`, `ctx.shell` and `ctx.fs` with container-backed providers, the same pattern as the `packages/ssh` providers. Model calls, session log and approvals stay in Harness, so no credentials enter the worker by construction.
2. **Code is an agent preset, not a provider swap.** Presets are per-session plugin trees (`packages/preset/agent-preset`). Tools registered in an agent scope shadow global ones, and `cordis:group` `isolate:` realms keep the preset's providers visible only to its own tools. Ordinary Chat sessions are untouched.
3. **Deletion hooks archive.** Harness has no session-delete capability. Archiving a Code session deletes its workspace (`workspace/session-archived`); the header also has an explicit Delete workspace action.
4. **No Harness changes.** Code mode is chosen in the Harness mode selector, and repository and branch in the composer's + menu (`ctx.commandUi`). An earlier sidebar switch needed two fork extension points (`sidebar.mode`, `uiWorkspace.registerSessionFilter`); it was dropped. State the Harness owns, such as a session's preset, is read from it on every check, never mirrored from events.
5. **Standalone repository and build.** Built against published `@deepseek-ai/*@0.2.2-rc.1` packages; the Typert generator is patched (`patches/`) to accept the npm-installed protocol package; the client bundle format is emitted by `packages/dsh-code/tsdown.client.ts`.

## Answers to spec §23

| # | Question | Finding |
|---|---|---|
| 1 | Documented UI slot for repo/branch selectors | Yes: `conversation.hero.options`, `conversation.input.dock`, `conversation.session.header.actions`, `settings.section`. The mode selector (agent presets) and the + menu (`ctx.commandUi`) cover Code without a top switch or session-list filter |
| 2 | Full Harness runtime in gVisor, controlled externally | Possible (SDK/ACP over stdio) but rejected, see decision 1 |
| 3 | Existing source control integration | `experimental/forge*` handles existing PRs only and authenticates through `gh`; no repo listing, clone, push or create-PR API. This repo adds its own `gh`-based provider |
| 4 | Remote client attaches to a running session | Locally yes (gateway + session-controller follow with sequence repair). Remotely partly: experimental Liveshare has an outbound relay tunnel and RBAC, but viewers cannot approve, the relay server is not in the repo, and there is no replay across tunnel restarts |
| 5 | Durable ordered replay | Session log sequence numbers, yes; forwarded notifications, no |
| 6 | Models and credentials via existing services | Yes under decision 1 |
| 7 | OS/architecture passing gVisor | Linux x86_64 verified (runsc release-20261102.0). macOS/Windows untested |
| 8 | Online persistence and recovery | None: Harness is single-owner, no users/orgs/managed hosts |

## Escapes found and closed

- Host Git in a sandbox-writable checkout runs planted hooks, filters and fsmonitor commands. Fixed: after the container starts, Git runs inside it; pushes import a Git bundle into a host-owned mirror.
- `fs-sandbox` fences writes only; host-side file tools could read any host file. Fixed: `ConfinedFileSystem` fences every operation to the session's workspace (remaining race: see [plan.md](plan.md)).
- `subagent-dsh-sdk`, Claude Code/Codex subagents and stdio MCP clients spawn processes directly on the host. The `code` preset omits subagent and workflow tools.
- Docker embedded DNS is unreachable from gVisor's network stack, and any DNS in the worker allows tunnelling. The worker has no DNS; the proxy address is pinned with `--add-host`.
