# DeepSeek Harness Code Workspaces

**Product and Technical Specification**  
**Version:** 1.0  
**Date:** 11 November 2026  
**Status:** Proposed architecture, pending validation against the actual fork

## 1. Executive summary

Extend DeepSeek Harness with a Claude Code style coding experience using its existing chat interface, repository and branch selectors, automatic isolated execution, and Remote Control.

The user opens **Code**, selects a Git repository and optionally a base branch, and chats normally. The first message provisions a Docker container with **gVisor (`runsc`)** and starts a Harness worker inside it. Every Code conversation has a separate workspace and working branch. The workspace persists between messages. Deleting a Code session removes its container and session owned temporary resources, with appropriate warnings for uncommitted changes.

The feature is developed and tested locally first. The eventual online deployment supports teams using managed Docker + gVisor hosts and also allows authorised users to remotely control sessions still running on their own machines. **Remote Control does not migrate execution. Teleport is out of scope.**

The plugin must reuse Harness models, credentials, tools, sessions, permissions and source control integration where available. The implementation is **plugin first and upstream compatible**; core changes are a last resort and must be generic.

## 2. Product principles

1. **Chat first:** Extend the existing Harness chat. Do not create a separate coding chat engine.
2. **Fast first value:** Select repository, optionally branch, then send a message. No environment selection per chat.
3. **Fixed runtime:** Docker + gVisor only. Never silently fall back to ordinary Docker.
4. **Configuration inheritance:** Use the effective Harness user configuration, or configured instance capabilities when local Harness has no authentication.
5. **Isolation by session:** One container and writable workspace per Code conversation.
6. **Local first, online final:** Prove local execution before introducing team control plane infrastructure.
7. **Remote Control only:** Online access to the original running session, without moving it.
8. **Plugin first:** Reuse documented Harness extension interfaces and existing Git integration.
9. **Secure defaults:** Network restrictions, scoped credentials, non privileged containers and auditable approvals.
10. **No duplicate platform:** Harness remains responsible for agents, chat, models and tool orchestration.

## 3. Scope

### In scope

- Code mode in existing Harness chat.
- Repository dropdown and optional base branch dropdown.
- Automatic Docker + gVisor setup and validation through guided plugin installation.
- Dedicated workspace and working branch per conversation.
- Harness worker running inside each isolated container.
- Multiple parallel Code sessions.
- Session lifecycle, recovery, deletion and cleanup.
- Existing Harness models, credentials, tools, skills and MCP integrations, subject to security policy.
- Configurable outbound network access and controlled application previews.
- Source control operations, diffs, commits and pull requests using existing integrations or a separate reusable source control plugin.
- Remote Control through authenticated online Harness.
- Team deployment using managed Docker + gVisor hosts.
- Observability, security tests and operational recovery.

### Out of scope

- Teleport and session migration.
- AWS/Azure execution provider choice or other runtime backends.
- Custom agent framework, LLM provider system or replacement chat UI.
- Automatic deployment of generated applications.
- Live process migration or transparent host failover.

## 4. User experience

### 4.1 First time setup

1. Install Code Workspaces plugin.
2. Guided setup detects OS, architecture, Docker and gVisor prerequisites.
3. With explicit permission, install or configure missing system dependencies where supported.
4. Download a pinned, verified Harness worker image.
5. Run a gVisor isolation, worker compatibility and connectivity self test.
6. Enable Code only after all mandatory checks pass.
7. Connect source control through existing Harness integration, if not already configured.

Do not ask the user to select an execution provider. Advanced resource and network settings live in **Settings > Code**.

### 4.2 Starting a conversation

The user opens Code in the existing Harness chat and sees:

- Repository dropdown, populated using the current source control identity.
- Branch dropdown, defaulting to the repository's default branch.
- Existing chat composer, attachments, model selector, tool display and approvals.

The user submits a prompt. Harness creates a logical session; Workspaces provisions the container, resolves a pinned base commit, creates a unique working branch, starts the worker, and streams results into the normal chat.

Show concise provisioning progress. Do not block the UI on unnecessary dependency installation.

### 4.3 Existing conversation

- Follow up messages use the same workspace.
- Repository and base commit are fixed for that session.
- Stopping a turn does not delete the workspace.
- Model changes follow normal Harness semantics, subject to policy.
- Files, diffs, tests and tool events are visible through existing UI patterns.
- Multiple sessions can work on the same repository without sharing writable filesystems.

### 4.4 Session actions

- Continue conversation.
- Cancel active turn.
- Restart worker while preserving recoverable files.
- Inspect changed files and diffs.
- Commit and create PR through source control provider.
- Open remotely, when paired with online Harness.
- Delete session and execution resources.

Deletion requires a warning when uncommitted changes will be lost. Remote branches, commits and PRs remain unless explicitly deleted separately.

### 4.5 Session states

`Created`, `Provisioning`, `Ready`, `Running`, `Waiting for approval`, `Idle`, `Offline`, `Restarting`, `Failed`, `Deleting`, `Deleted`.

A logical session ID must not be the same as a Docker container ID.

## 5. Architecture

```text
                    Existing Harness Chat UI
            Code mode | repo | branch | chat | approvals
                              |
                   Trusted Harness Control Plane
           sessions | auth | policy | models | credentials
           source control | workspace manager | routing
                              |
              +---------------+---------------+
              |                               |
       Local Docker Host                Managed Docker Host
              |                               |
         Docker Engine                     Docker Engine
              |                               |
          gVisor runsc                     gVisor runsc
              |                               |
       +------+-------+                 +-----+--------+
       | Session A    |                 | Session C    |
       | Harness      |                 | Harness      |
       | worker       |                 | worker       |
       | agent/tools  |                 | agent/tools  |
       | repo/branch  |                 | repo/branch  |
       +--------------+                 +--------------+
```

**Trusted control plane:** UI, user and session identity, credentials, source control discovery, policy enforcement, Docker management and routing.

**Execution plane:** Harness worker, agent, executable tools, skills, repository and build processes within Docker + gVisor.

**Remote plane:** Authenticated gateway and outbound local connector that route authorised messages, approvals and events to the original session.

Do not expose Docker daemon, host credential database, SSH directory, browser profile or unrestricted host filesystem to the worker.

## 6. Component boundaries

| Component | Responsibility | Implementation preference |
| --- | --- | --- |
| Code UI extension | Repository and branch controls in existing chat | Existing Harness UI extension point |
| Source Control provider | Repos, branches, clone access, commits, PRs | Reuse Harness integration; otherwise separate reusable plugin |
| Workspaces plugin | Docker/gVisor setup, lifecycle, network, limits, reconciliation | Official plugin/provider interfaces |
| Workspace worker | Existing Harness agent runtime inside sandbox | Reuse Harness runtime |
| Credential/capability broker | Authorised model and external tool access | Existing Harness credential services |
| Remote Control plugin | Pairing, connection, routing, event replay | Existing session and SDK transport where possible |

No undocumented API dependencies or monkey patching. Do not change Harness core merely to simplify the plugin. If a generic extension is truly missing, propose it separately upstream with tests and compatibility guarantees.

## 7. Source control

Use the existing Harness GitHub/source control capability if it already supports the requirements. Otherwise create a separate source control provider plugin rather than placing GitHub authentication in Workspaces.

Required operations:

- List repositories available to effective user.
- List branches and identify default branch.
- Resolve and pin base commit.
- Grant narrowly scoped clone access.
- Create unique session working branch.
- Fetch, diff, commit, push and create pull request.
- Handle expired or revoked permissions.

Each session owns a separate writable checkout. Branch naming must avoid collisions. Git credentials must not be copied wholesale into containers.

## 8. Docker and gVisor

### 8.1 Runtime contract

`Harness -> Docker Engine -> gVisor (runsc) -> Harness worker`

No fallback to ordinary Docker. A failed gVisor validation blocks Code execution and provides a recovery action.

### 8.2 Supported host strategy

- **Linux:** Native Docker Engine and gVisor.
- **macOS:** Linux VM such as Colima, with Docker and gVisor installed/configured inside the VM.
- **Windows:** Compatible Linux environment, typically WSL2, with Docker and gVisor.

Support must be validated on actual OS/architecture combinations. System changes require explicit user consent and may require administrator permissions or restarts. Installation cannot be assumed to be fully automatic on every platform.

### 8.3 Security defaults

| Control | Requirement |
| --- | --- |
| Runtime | `runsc` |
| Privileged | False |
| User | Non root |
| Linux capabilities | Drop all, add only strictly necessary capabilities |
| Privilege escalation | `no-new-privileges` |
| Root filesystem | Read only where compatible |
| Writable storage | Dedicated workspace and temp paths |
| Docker socket | Never mounted |
| Host mounts | No unrestricted host paths |
| CPU/memory/processes | Enforced limits |
| Disk | Enforced quota where supported |
| Network | Controlled egress, private networks denied by default |
| Credentials | Narrow scope and short lifetime where possible |
| Worker image | Pinned digest and verified source |

Proposed initial local defaults: 2 vCPU, 4 GB RAM, 10 GB writable workspace, 512 processes. These are adjustable and must be benchmarked.

### 8.4 Lifecycle

1. Create logical session and workspace record.
2. Resolve identity, policy and repository revision.
3. Create container with `runsc`, dedicated storage and network policy.
4. Start Harness worker and verify health.
5. Deliver first prompt.
6. Keep container available across conversation turns.
7. Reconcile Docker state after host or control plane restart.
8. On deletion, stop agent, revoke scoped access, remove container, owned storage, network resources and registration.
9. Retry incomplete cleanup and report outstanding resources.

Container removal alone does not delete external Git branches, pull requests, images or unrelated Docker volumes.

## 9. Network access

Network settings are configured once under **Settings > Code > Network**, with additional organisation restrictions online.

Default: **Approved outbound destinations only**. Common approved endpoints may include source control and package registries. Model traffic can use a trusted Harness capability gateway rather than direct worker internet access.

Supported policies:

- Approved destinations only (default).
- No external access.
- Broad internet access only with explicit authorised configuration.
- Explicit approval for private network destinations.

Enforcement must use a trusted egress gateway or equivalent controls outside the worker. Docker bridge networking and DNS allowlists alone are insufficient.

Must protect against:

- Direct IP bypass.
- DNS rebinding and DNS tunnelling.
- IPv6 bypass.
- Redirects to blocked destinations.
- Private IP ranges and host management endpoints.
- Cloud metadata endpoints.
- Unauthorised inbound connections.
- Proxy bypass and long lived connections after policy updates.

Agent code cannot modify its own network policy. Policy changes are control plane operations.

**Application previews:** Allow explicit preview ports through an authenticated trusted proxy. Do not publish arbitrary worker ports on the host's public interface.

## 10. Identity, models and credentials

### 10.1 Effective configuration

| Context | Effective identity and configuration |
| --- | --- |
| Authenticated local Harness | Logged in user's permitted models, tools, credentials and policies |
| Unauthenticated local Harness | Instance configured models, tools, credentials and policies |
| Authenticated online Harness | User configuration intersected with organisation policy |
| Remotely opened local session | Original local session's execution identity and effective configuration |

Use the existing Harness model selector and integrations. Do not duplicate provider configuration in Workspaces.

### 10.2 Secret handling

Inherit **capabilities**, not unrestricted access to secrets.

Preferred flow:

`Worker -> trusted local capability gateway -> existing Harness provider -> external service`

Where direct worker access is unavoidable, provide a scoped, short lived credential. Never mount the full Harness credential store, home directory, SSH directory or browser profile. Redact credentials from prompts, logs, events and errors.

### 10.3 Skills, tools and MCP

- Sandbox executable tools and skills run inside the worker.
- Trusted external integrations run behind authorised capability boundaries.
- User enabled third party code must not automatically execute in the trusted host process.
- Model changes can take effect during a session if authorised.
- Credential revocations and tighter network restrictions must take effect promptly.
- Repository identity and base commit remain fixed for a session.

### 10.4 Anonymous mode limitation

An unauthenticated local Harness instance is a single trusted local context, **not** a multiuser security boundary. Remote Control still requires authenticated pairing.

## 11. Remote Control

### 11.1 Goal

Access a Code session from online Harness while its agent, repository and Docker container continue running on the original local machine. No Teleport and no migration.

### 11.2 Topology

```text
Online Harness browser
       |
Online Harness control plane
(auth, session directory, remote gateway)
       |
TLS authenticated relay
       |
Outbound local connector
       |
Local Harness session manager
       |
Docker + gVisor Harness worker
```

The local connector initiates the outbound connection. No inbound home router port forwarding or direct public Docker access.

### 11.3 Pairing

1. User authenticates to online Harness.
2. Local Harness requests a short lived pairing challenge.
3. User confirms locally.
4. Local connector receives a revocable device scoped identity.
5. Online session directory shows only sessions authorised for that pairing.
6. Either side can revoke pairing.

Pairing identity is separate from model and Git credentials.

### 11.4 Remote operations

- List authorised remote sessions.
- Open and observe conversation.
- Send messages and cancel turns.
- Stream assistant and tool events.
- Approve/reject actions according to user permissions.
- Inspect diffs and authorised previews.
- Reconnect and replay missed events.
- Show host offline state.
- Revoke access.

The local session remains authoritative for execution and its original credentials. Opening it from another browser must not silently replace the execution identity.

### 11.5 Connection failure

- Browser disconnect: agent continues.
- Online gateway restart: local agent continues.
- Local internet disconnect: agent continues where external dependencies permit.
- Local computer sleeps or powers off: remote session unavailable.
- Local host restart: reconcile and recover where possible.
- Container crash: mark failed and offer controlled restart.
- Pairing revoked: remote access stops immediately.

### 11.6 Concurrency and audit

Multiple clients may observe a session. Mutating operations are serialised unless Harness explicitly supports concurrency. Every approval must be bound to a user, action and session. Duplicate and late approvals are rejected. Record remote access and control events in an audit trail.

## 12. Online team deployment

The final operating model includes a shared online Harness control plane and managed Linux worker hosts running the same Docker + gVisor architecture. It also accepts paired local hosts for Remote Control.

A team member opens Code in the browser, selects a repository and starts chatting. Policy determines which managed host runs the container. No execution provider selection is shown.

**Online responsibilities:** Authentication, session directory, ownership, permissions, policy, credential access, durable event storage, remote gateway, worker registration, audit and administration.

**Managed worker responsibilities:** Provision session containers, enforce host policies, report health, reconcile lifecycle and preserve recoverable workspace state.

### Sharing and permissions

- Sessions are private by default.
- Explicit viewer and controller permissions.
- Approvals require separate authorisation.
- Sharing a session does not automatically grant access to unrelated repositories or credentials.
- Revocation takes effect promptly.
- Organisations and users must be isolated at the control plane and worker level.

For multi organisation deployments, evaluate host level separation in addition to gVisor before promising strong tenant isolation.

## 13. Session data model (conceptual)

```ts
interface CodeSession {
  id: string;
  ownerId: string | null;
  repositoryId: string;
  baseBranch: string;
  baseCommit: string;
  workingBranch: string;
  workspaceId: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

interface Workspace {
  id: string;
  sessionId: string;
  hostId: string;
  containerId: string;
  runtime: 'gvisor';
  imageDigest: string;
  status: WorkspaceStatus;
  policyId: string;
}

interface RemoteBinding {
  sessionId: string;
  hostId: string;
  authorisedPrincipalIds: string[];
  connectionStatus: 'online' | 'offline';
}
```

Map these concepts onto existing Harness entities and persistence rather than creating duplicate sources of truth.

## 14. Worker transport (proposed, not verified Harness APIs)

Required semantics:

| Operation | Purpose |
| --- | --- |
| `worker.register` | Establish identity and capabilities |
| `session.start` | Start or attach session |
| `session.message` | Send user message |
| `session.cancel` | Cancel active turn |
| `session.event` | Stream agent/tool events |
| `session.approval` | Submit authorised decision |
| `session.snapshot` | Read logical state |
| `session.replay` | Replay events after sequence number |
| `workspace.status` | Health and resource usage |
| `workspace.stop` | Stop worker execution |
| `workspace.delete` | Controlled cleanup |

Transport needs version negotiation, scoped identity, sequence numbers, idempotency keys, heartbeat, backpressure, size limits, replay and structured errors. Prefer existing Harness SDK/session transport.

## 15. Functional requirements

| ID | Requirement | Priority |
| --- | --- | --- |
| CODE-01 | Repository selector in existing chat | Must |
| CODE-02 | Branch selector from selected repo | Must |
| CODE-03 | Default to repository default branch | Must |
| CODE-04 | Auto provision on first message | Must |
| CODE-05 | Preserve workspace across turns | Must |
| CODE-06 | Unique working branch per session | Must |
| CODE-07 | Parallel isolated sessions | Must |
| CODE-08 | Reuse Harness models/tools/approvals | Must |
| CODE-09 | View changed files and diffs | Must |
| CODE-10 | Commit and create PR | Should |
| CODE-11 | Recover after UI/transport interruptions | Must |
| CODE-12 | Cleanup on session deletion | Must |
| CODE-13 | Preserve ordinary chat behaviour | Must |
| CODE-14 | Resource usage view | Should |
| CODE-15 | Remember recent repositories | Should |
| REM-01 | Pair local Harness with online account | Must |
| REM-02 | Authenticated outbound local connector | Must |
| REM-03 | Remote message, event and approval routing | Must |
| REM-04 | Reconnect and replay | Must |
| REM-05 | Authorised session discovery | Must |
| REM-06 | Remote access revocation | Must |

## 16. Non functional requirements

The following are **proposed targets**, not measured guarantees.

| ID | Category | Target |
| --- | --- | --- |
| NFR-01 | First value | First useful repo operation within 30 seconds P90 on warm worker/small repo |
| NFR-02 | UI | Acknowledge submitted message within 500 ms P95, excluding outages |
| NFR-03 | Isolation | One dedicated gVisor container per session |
| NFR-04 | Security | Never fall back to ordinary Docker |
| NFR-05 | Credentials | No full credential store in worker |
| NFR-06 | Network | Enforced egress policy for all worker traffic |
| NFR-07 | Reliability | Control plane restart does not terminate local agent |
| NFR-08 | Recovery | Replay events without duplicate tool execution |
| NFR-09 | Cleanup | Complete within 60 seconds P95 on healthy host |
| NFR-10 | Concurrency | Configurable session limits per host |
| NFR-11 | Observability | Correlate session, workspace, worker and tool events |
| NFR-12 | Compatibility | Ordinary Harness chat unchanged |
| NFR-13 | Portability | Linux first; macOS/Windows after tests |
| NFR-14 | Accessibility | Keyboard accessible controls |
| NFR-15 | Upgrade | Explicit worker/plugin version compatibility |
| NFR-16 | Audit | Attribute remote actions and approvals |

## 17. Observability

Capture:

- Session creation, ownership, state, approvals and deletion.
- Worker version, startup, heartbeat, crashes and tool errors.
- Container CPU, memory, disk, process count and termination reason.
- Network allow/deny events and policy violations.
- Remote pairing, connections, latency, replay and failures.
- Git clone, branch, push and permission errors.

Provide diagnostics for session ID, workspace ID, host, container health, image digest, last heartbeat, network policy, resource usage, sanitised errors and cleanup status.

Do not export source code or sensitive tool output to third party telemetry by default. Redact secrets.

## 18. Failure handling

| Failure | Behaviour |
| --- | --- |
| Docker missing | Guided setup or repair |
| gVisor missing/failing | Block Code execution |
| Worker image unavailable | Retry verified download; show error |
| Git authentication fails | Reconnect source control |
| Clone fails | Preserve logical session and retry |
| Resource limit exceeded | Stop affected execution; preserve recoverable state if possible |
| Worker crash | Mark failed; controlled restart |
| Remote disconnect | Continue local execution |
| Credential revoked | Deny affected operations |
| Network denied | Report destination and applicable policy |
| Cleanup fails | Retry and report outstanding resources |
| Host restart | Reconcile Docker and session state |

## 19. Security verification

Release gates include tests for:

- Sandbox escape attempts and host filesystem access.
- Docker socket and privileged operation access.
- Network bypass through IP, DNS, IPv6, redirects and private networks.
- Secret exfiltration and token replay.
- Cross session and cross user isolation.
- Unauthorised remote attachment and forged approvals.
- Orphaned containers, stale credentials and incomplete deletion.
- Malicious repository dependencies, scripts, skills and tools.
- Worker image integrity and supply chain.
- Crash, daemon restart and gateway recovery.
- gVisor compatibility with common development stacks.

Do not rely on agent prompts to enforce security boundaries.

## 20. Delivery phases

### Phase 0: Fork compatibility assessment

Inspect actual fork and identify documented extension points for chat controls, source control, worker process, session persistence, remote transport, event replay and credentials. Produce evidence based matrix. No core changes without this assessment.

### Phase 1: Local runtime foundation

Implement Docker/gVisor setup, pinned worker image, isolated Harness worker, lifecycle, cleanup and security tests. Demonstrate programmatic execution before new UI.

### Phase 2: Code chat experience

Add repo/branch selectors to existing chat, source control integration, session binding, agent streaming and diffs.

### Phase 3: Security and configuration inheritance

Integrate effective user context, credential broker, egress enforcement, permissions, resource limits and diagnostics.

### Phase 4: Remote Control

Implement pairing, outbound connector, online gateway, session routing, approvals and replay. Verify local execution continues after browser disconnect.

### Phase 5: Online team deployment

Add authenticated online control plane, managed Linux Docker/gVisor worker hosts, durable storage, team sharing, policy and operational monitoring.

## 21. Proposed package layout

```text
harness-code/
  plugins/
    code-ui/
      repository-selector/
      branch-selector/
      session-status/
      diff-view/
    source-control/
      provider-contract/
      github-adapter/
    workspaces/
      workspace-manager/
      docker-controller/
      gvisor-installer/
      image-manager/
      network-policy/
      credential-broker/
      resource-monitor/
      lifecycle-reconciler/
    remote-control/
      pairing/
      connector/
      gateway/
      session-routing/
      event-replay/
      authorisation/
  worker/
    harness-bootstrap/
    connection-client/
    health-reporter/
  contracts/
    workspace/
    worker-protocol/
    remote-session/
  tests/
    integration/
    security/
    compatibility/
    end-to-end/
```

Logical layout only; follow the actual Harness repository conventions.

## 22. Acceptance criteria

### Local MVP

- [ ] Install plugin and complete Docker + gVisor validation.
- [ ] Open Code within existing Harness chat.
- [ ] Select repository and branch.
- [ ] Send first message without environment selection.
- [ ] Run agent and tools inside gVisor.
- [ ] Reuse permitted Harness models, tools and credentials.
- [ ] Enforce network restrictions, including bypass tests.
- [ ] Run two sessions without filesystem interference.
- [ ] Reconnect to an existing session.
- [ ] Delete a session and verify complete owned resource cleanup.
- [ ] Pass security, compatibility and ordinary chat regression tests.

### Online release

- [ ] Authenticate team members and enforce session/repo permissions.
- [ ] Run managed workspaces on Docker + gVisor hosts.
- [ ] Pair local Harness with online Harness securely.
- [ ] Open and control local session remotely without moving execution.
- [ ] Preserve local execution through browser/gateway disconnect.
- [ ] Replay missed events without duplicate execution.
- [ ] Apply per user credential and permission policies.
- [ ] Support viewer/controller sharing and authorised approvals.
- [ ] Enforce administrative network and security restrictions.
- [ ] Document recovery and operational procedures.

## 23. Decisions requiring fork validation

1. Does the existing chat expose a documented plugin UI slot for repo/branch selectors?
2. Can the full Harness runtime run in a gVisor worker and be controlled externally?
3. Is there an existing GitHub/source control integration that meets requirements?
4. Can a remote client attach to a running session using documented transport?
5. Can session events be replayed durably with correct ordering?
6. Can models and credentials be mediated using existing Harness services?
7. Which host OS/architecture combinations pass gVisor compatibility tests?
8. What persistent storage and host recovery are available in online deployment?

## 24. Definition of done

A developer installs the plugin, opens the existing Harness chat, selects a repository, sends a coding task and receives useful code changes from an isolated Docker + gVisor worker. The session uses existing authorised Harness capabilities, supports multiple parallel workspaces, preserves context across messages and cleans up owned resources on deletion.

The developer can then open the same locally running session from authenticated online Harness, view its events, send messages and approve actions, while execution stays on the local machine. Finally, the same experience works for a team on managed Docker + gVisor worker hosts with enforced identity, permissions, network policy and audit.

**Architecture boundary:** Harness owns agents, chat, sessions, models and integrations. Source Control owns Git operations. Workspaces owns isolated execution. Remote Control owns remote access. Core changes require proof that documented plugin interfaces cannot meet the need.
