/** Loader-owned tools keep remote refusal text and frozen sender identity observable. */
import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@panedesk/dsh-llm'
import { decodeRoutedSeatSend, type NodeLinkStatus } from '@panedesk/dsh-node-link'
import type { MessageReason, RoutedSeatMessageRequest } from '@panedesk/dsh-message-delivery'
import { composition } from './composition.ts'

function text(result: { content: readonly { type: string; text?: string }[] }) {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}
describe('remote seat tools through Loader', () => {
  it.each([
    ['target-not-found', 'No such seat / 无此位'],
    ['offline', 'Seat is offline / 位不在线'],
    ['busy-not-accepting', 'Seat is busy and not accepting messages / 位忙且不接收消息'],
  ] as const)('preserves %s with bilingual text and one original request', async (reason, explanation) => {
    const f = await composition(true)
    const deliveries: RoutedSeatMessageRequest[] = []
    f.ctx.provide('nodeDelegationIssuer', { expiry: { maxLifetimeMs: 10000, maxClockSkewMs: 0 }, issue: async prepared => ({
      status: 'issued', delegation: { kind: 'node-delegation', hop: 1, taskIds: [], sessionId: f.sender.id,
        authorizationRef: 'authority' as import('@panedesk/dsh-node-link').NodeWireRequest['delegation']['authorizationRef'],
        principalId: 'principal' as import('@panedesk/dsh-node-link').NodeWireRequest['delegation']['principalId'],
        sourceNodeId: prepared.sourceNodeId, targetNodeId: prepared.targetNodeId, operationId: prepared.operationId,
        requestDigest: prepared.payloadDigest, expiresAt: prepared.deadline } }) })
    f.ctx.provide('nodeRouter', { status: async () => [], route: async (wire) => {
      if (wire.method !== 'messages.sendSeat') throw new Error('Unexpected method')
      const payload = decodeRoutedSeatSend(wire.payload)
      deliveries.push(payload)
      return { ...wire, status: 'ok', result: { messageId: payload.delivery.message.messageId,
        operationId: payload.operationId, deliveryOutcome: 'rejected', messageState: 'rejected', pending: false,
        reason, candidates: [] } }
    } })
    try {
      const call = ToolCallId('remote-refusal'), args = { node: 'node-b', seat: 'receiver', text: 'Original handoff' }
      const first = text(await f.execute('seat_send', args, call))
      expect(text(await f.execute('seat_send', args, call))).toBe(first)
      const result = JSON.parse(first) as { reason: MessageReason; explanation: string }
      expect(result.reason).toBe(reason)
      expect(result.explanation).toBe(explanation)
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0]?.delivery.message.sender).toEqual({ kind: 'session', sessionId: f.sender.id })
      expect(deliveries[0]?.target).toEqual({ nodeId: 'node-b', seat: 'receiver' })
      expect(deliveries[0]?.content).toMatchInlineSnapshot(`
        "Free window "sender":
        Original handoff"
      `)
    } finally { await f.close() }
  })
  it('renders unknown state for an unreachable node in the existing list tool', async () => {
    const f = await composition(true)
    const state: NodeLinkStatus = { nodeId: 'node-b' as NodeLinkStatus['nodeId'], nodeName: 'peer', reachable: false,
      linkState: 'disconnected', observedAt: new Date().toISOString(), status: null, capabilities: [], safeReason: null }
    f.ctx.provide('nodeRouter', { status: async () => [state], route: async () => { throw new Error('Offline query dispatched') } })
    try {
      const rows = JSON.parse(text(await f.execute('seat_list_online', {}))) as { nodeId: string }[]
      expect(rows.filter(row => row.nodeId === 'node-b')).toMatchInlineSnapshot(`
        [
          {
            "explanation": "Node state unknown / 节点状态未知",
            "nodeId": "node-b",
            "reason": "unavailable",
            "status": "unknown",
          },
        ]
      `)
    } finally { await f.close() }
  })
})
