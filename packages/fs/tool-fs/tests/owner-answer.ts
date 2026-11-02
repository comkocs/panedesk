/** Authenticated owner event-stream fixture for workspace consent regressions. */
import { Context } from '@panedesk/cordis'
import { SessionId } from '@panedesk/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@panedesk/dsh-user-approval'
import TypertRegistry from '@panedesk/dsh-typert-registry'
import Gateway from '@panedesk/dsh-api-gateway'
import RemoteAccess from '@panedesk/dsh-api-remote-access'
import * as Remotes from '@panedesk/dsh-api-remotes'
import { Peer, apply as applyConnection, inject as connectionInject } from '@panedesk/dsh-client-connection'
import { provideBrowserCredentials } from '../../../api/gateway/tests/browser-credentials.ts'
import type { RemoteEventDownlinkFrame, RemoteEventResult } from '../../../api/gateway/src/stream-protocol.ts'

/**
 * Answer workspace consent over the same authenticated event transport as the owner frontend.
 * @param ctx - Host fixture whose lifetime owns the event stream.
 * @param listener - Test owner decision, including cancellation observation.
 */
export async function ownerAnswer(
  ctx: Context, listener: (request: ApprovalRequest) => Promise<ApprovalOutcome>,
): Promise<() => Promise<void>> {
  const host = ctx.root
  if (host.get('credentials') === undefined) provideBrowserCredentials(host)
  if (host.get('connection') === undefined) await host.plugin({ inject: [...connectionInject], apply: applyConnection })
  if (host.get('typert') === undefined) await host.plugin(TypertRegistry)
  if (host.get('remoteAccess') === undefined) await host.plugin(RemoteAccess)
  if (host.get('typertGateway') === undefined) await host.plugin(Gateway)
  const remotes = await host.plugin(Remotes)
  const gateway = host.get('typertGateway')
  const connection = host.get('connection')
  const agents = host.get('agents')
  if (gateway === undefined || connection === undefined || agents === undefined) throw new Error('Missing owner transport services')
  const peer = new Peer(host, { principal: { kind: 'owner' } })
  const controller = new AbortController()
  const stream = await gateway.wireStream.open('$events', { args: {} }, (async function* () {})(), peer, controller.signal)
  const events = stream[Symbol.asyncIterator]() as AsyncIterator<RemoteEventDownlinkFrame>
  const ready = await events.next()
  if (ready.done || ready.value.type !== 'ready') throw new Error('Expected an owner event stream')
  const clientId = ready.value.clientId
  const pending = new Map<string, AbortController>()
  const responses = new Set<Promise<void>>()
  const send = async (eventId: RemoteEventResult['eventId'], outcome: RemoteEventResult['outcome']) => {
    const response = await connection.createSharedFetchHandler('/api').fetch(new Request('http://localhost/api/$events/result', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: eventId, method: '$events/result',
        payload: { args: { clientId, eventId, outcome } } }),
    }), peer)
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null || !('result' in body)
      || typeof body.result !== 'object' || body.result === null || !('ok' in body.result) || body.result.ok !== true) {
      throw new Error('Owner event reply was refused')
    }
  }
  const pump = (async () => {
    while (true) {
      const item = await events.next()
      if (item.done) return
      const frame = item.value
      if (frame.type === 'cancel') { pending.get(frame.eventId)?.abort(); continue }
      if (frame.type !== 'waterfall') continue
      const agent = agents.get(SessionId(frame.agentId))
      const purpose = frame.request.purpose
      const toolName = frame.request.toolName
      if (agent === undefined || typeof toolName !== 'string') throw new Error('Expected an owner approval request')
      let workspace: string | undefined
      if (purpose !== undefined) {
        if (typeof purpose !== 'object' || purpose === null
          || !('type' in purpose) || purpose.type !== 'workspace-write'
          || !('workspace' in purpose) || typeof purpose.workspace !== 'string') {
          throw new Error('Expected a workspace consent purpose')
        }
        workspace = purpose.workspace
      }
      const signal = new AbortController()
      pending.set(frame.eventId, signal)
      const response = Promise.resolve().then(() => listener({
        agent, toolName, signal: signal.signal,
        ...workspace === undefined ? {} : { purpose: { type: 'workspace-write', workspace } },
      })).then(
        value => signal.signal.aborted ? undefined : send(frame.eventId, { kind: 'result', value }),
        (error: unknown) => signal.signal.aborted ? undefined : send(frame.eventId, {
          kind: 'rejected', error: { name: 'Error', message: error instanceof Error ? error.message : String(error) },
        }),
      ).finally(() => { pending.delete(frame.eventId); responses.delete(response) })
      responses.add(response)
    }
  })()
  const close = async () => {
    controller.abort()
    for (const signal of pending.values()) signal.abort()
    await events.return?.()
    await pump
    await Promise.all(responses)
    await peer.dispose()
    await remotes.dispose()
  }
  ctx.effect(() => close)
  return close
}
