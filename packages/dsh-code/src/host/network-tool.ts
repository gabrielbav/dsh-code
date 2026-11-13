/**
 * `request_network_access`: the Code agent asks the user to allow one more host for this session's workspace.
 *
 * The user decides on the Harness's own approval card. An approval adds the exact host name to this one session's
 * egress allowlist (the proxy recognizes the workspace by its address on the internal network); other sessions and
 * the shared allowlist in Settings > Code are unchanged. Nothing is granted without an answer from the user:
 * a session that never asks, a missing approval service, a cancelled or rejected question all leave the policy as is.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isIP } from 'node:net'
import { decideRequest, normalizeHost, policyForClient } from '../egress/policy.ts'
import type { WorkspaceManager } from '../core/workspaces.ts'
import type {} from './workspaces-service.ts'

/** Cordis plugin name. */
export const name = 'code-network-tool'

/** The tool needs the workspaces service; approval is looked up per call (it may be absent). */
export const inject = ['tools', 'codeWorkspaces']

/** Tool name, also used in the proxy's block message. */
export const TOOL_NAME = 'request_network_access'

/** Outcome reported to the model. */
export type NetworkRequestOutcome =
  | 'granted' | 'already-allowed' | 'declined' | 'not-asked' | 'network-disabled' | 'invalid-host' | 'no-workspace'

/** Minimal approval surface used here (`@deepseek-ai/dsh-user-approval`). */
export interface Approver {
  policyOf(session: unknown): 'ask' | 'never'
  request(request: {
    agent: unknown, toolName: string, callId?: unknown, reason?: string, signal?: AbortSignal,
    displayReason?: { en: string, [locale: string]: string },
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

/** What one request needs, separated from Cordis for tests. */
export interface NetworkRequestInput {
  readonly manager: Pick<WorkspaceManager, 'config' | 'networkGrants' | 'grantNetwork' | 'get' | 'owning'>
  readonly approver: Approver | undefined
  readonly agent: { readonly id: unknown; readonly session: unknown } | undefined
  /** The agent's working directory: a spawned or forked subagent has its own id but works in its parent's checkout. */
  readonly workingDirectory?: string | undefined
  readonly callId?: unknown
  readonly signal?: AbortSignal
  readonly host: string
  readonly reason: string
}

/**
 * Decide one request: validate the host, ask the user, and grant it for this session only.
 * @param input - manager, approval service, calling agent and arguments.
 * @returns the outcome and a sentence for the model.
 */
export async function requestNetworkAccess(input: NetworkRequestInput): Promise<{ outcome: NetworkRequestOutcome; message: string }> {
  const host = normalizeHost(input.host.replace(/^[a-z]+:\/\//i, '').replace(/[/:].*$/, ''))
  if (host === undefined || isIP(host) !== 0 || !host.includes('.')) {
    return { outcome: 'invalid-host', message: `"${input.host}" is not a host name. Pass one DNS name such as registry.example.com, without scheme, port or path; IP addresses are never allowed.` }
  }
  const agent = input.agent
  const record = agent === undefined ? undefined
    : input.manager.get(String(agent.id)) ?? (input.workingDirectory === undefined ? undefined : input.manager.owning(input.workingDirectory))
  const sessionId = record?.sessionId
  if (agent === undefined || sessionId === undefined) {
    return { outcome: 'no-workspace', message: 'This session has no Code workspace yet, so there is nothing to grant network access to.' }
  }
  const shared = input.manager.config.policy
  if (shared.mode === 'none') {
    return { outcome: 'network-disabled', message: 'External network access is off for Code sessions (Settings > Code > Network, or Lockdown). Hosts cannot be approved one by one; tell the user to change that setting if they want network access.' }
  }
  const current = policyForClient({ ...shared, clients: { self: input.manager.networkGrants(sessionId) } }, 'self')
  const port = shared.ports.includes(443) ? 443 : shared.ports[0] ?? 443
  if (decideRequest(current, host, port).allowed) {
    return { outcome: 'already-allowed', message: `${host} is already allowed for this session. If a request still fails, the cause is something else (port, DNS, or the server itself).` }
  }
  const approver = input.approver
  if (approver === undefined || approver.policyOf(agent.session) === 'never') {
    return { outcome: 'not-asked', message: `This session does not ask the user for approval, so ${host} was not allowed. Tell the user they can add it under Settings > Code > Allowed hosts, or switch this session to a mode that asks for approval and try again.` }
  }
  // The reason is model-written: one short line, so the host stays the prominent part of the card.
  const reason = input.reason.replace(/\s+/g, ' ').trim().slice(0, 200) || 'no reason given'
  const answer = await approver.request({
    agent, toolName: TOOL_NAME, callId: input.callId, signal: input.signal,
    reason: `allow network access to ${host} for this Code session: ${reason}`,
    displayReason: { en: `Allow the Code sandbox to reach ${host}? Only this session gets access. Reason given: ${reason}` },
  })
  if (answer === 'allowed-once') {
    await input.manager.grantNetwork(sessionId, host)
    return { outcome: 'granted', message: `The user allowed ${host} for this session. Retry the request now (ports ${shared.ports.join(', ')}).` }
  }
  if (answer === 'cancelled') input.signal?.throwIfAborted()
  return { outcome: 'declined', message: `The user did not allow ${host}. Do not ask again for this host in this turn; continue without it or ask the user how to proceed.` }
}

/** Register the tool inside the Code preset. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: 'Ask the user to allow the Code sandbox to reach one more host (exact DNS name, no wildcards) for this session only. '
      + 'Use it when a request is refused by the egress proxy and the host is needed for the task: "[sandbox: network access to <host> denied by the Code egress policy]" '
      + 'for plain HTTP, or for HTTPS "CONNECT tunnel failed, response 403" (curl, git) or a 403 / E403 from a package manager. Take the host from the URL that failed. '
      + 'The user approves or declines on an approval card; the result says whether to retry.',
    parameters: {
      host: { type: 'string', required: true, description: 'The host name that was denied, for example registry.example.com.' },
      reason: { type: 'string', required: true, description: 'One short sentence shown to the user: why the task needs this host.' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    execute: async (args, exec) => {
      const manager = (ctx as unknown as { codeWorkspaces: { manager: WorkspaceManager } }).codeWorkspaces.manager
      let workingDirectory: string | undefined
      try {
        const wd = ctx.get('workingDirectory' as never) as { get(session: unknown): string } | undefined
        workingDirectory = exec.agent === undefined ? undefined : wd?.get(exec.agent.session)
      } catch {
        // No working directory for this agent: only its own id can name the workspace.
      }
      const result = await requestNetworkAccess({
        manager, approver: ctx.get('approval' as never) as Approver | undefined, workingDirectory,
        agent: exec.agent as never, callId: exec.callId, signal: exec.signal,
        host: args.host, reason: args.reason,
      })
      return JSON.stringify(result)
    },
    presentCall: args => ({ card: 'generic', title: `Request network access: ${args.host}`, kind: 'other', rawInput: args }),
  }))
}
