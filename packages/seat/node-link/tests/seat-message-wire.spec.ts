import { describe, expect, it } from 'vitest'
import { digest } from '@panedesk/dsh-host-admin'
import { decodeRequest, decodeResponse } from '../src/codec.ts'

function frame(method: string, payload: object) {
  const deadline = new Date(Date.now() + 60000).toISOString()
  return { version: 'node-link/v1', requestId: 'request-a', sourceNodeId: 'node-a', targetNodeId: 'node-b',
    operationId: 'operation-a', deadline, hop: 1, method, payload, payloadDigest: digest(payload),
    delegation: { kind: 'node-delegation', hop: 1, principalId: 'principal-a', authorizationRef: 'authority-a',
      sourceNodeId: 'node-a', targetNodeId: 'node-b', operationId: 'operation-a', requestDigest: digest(payload),
      taskIds: [], sessionId: 'sender-a', expiresAt: deadline } }
}
function send(seat = 'receiver') {
  const target = { nodeId: 'node-b', seat }
  const envelope = { deliveryId: 'delivery-a', sourceNodeId: 'node-a', message: {
    messageId: 'message-a', operationId: 'operation-a', sender: { kind: 'session', sessionId: 'sender-a' },
    senderSessionId: 'sender-a', target, content: 'handoff', messageClass: 'handoff', priority: 'steer',
    createdAt: 123, revision: 0, mailboxSequence: 0, stateVersion: 0 } }
  return frame('messages.sendSeat', { target, operationId: 'operation-a', content: 'handoff', messageClass: 'handoff',
    delivery: { ...envelope, digest: digest(envelope) } })
}
describe('closed seat message wire methods', () => {
  it('accepts one exact remote seat with the original frozen sender', () => {
    expect(decodeRequest(send())).toMatchObject({ method: 'messages.sendSeat', payload: { target: { seat: 'receiver' } } })
  })
  it.each(['target-not-found', 'offline', 'busy-not-accepting'])('preserves the target refusal %s', (reason) => {
    const request = decodeRequest(send())
    expect(decodeResponse({ version: request.version, requestId: request.requestId, operationId: request.operationId,
      sourceNodeId: request.sourceNodeId, targetNodeId: request.targetNodeId, method: request.method, status: 'ok',
      result: { messageId: 'message-a', operationId: 'operation-a', deliveryOutcome: 'rejected', messageState: 'rejected',
        pending: false, reason, candidates: [] } }, request)).toMatchObject({ result: { reason } })
  })
  it('accepts a bounded explicit online observation query', () => {
    expect(decodeRequest(frame('messages.onlineSeats', { operationId: 'operation-a' })))
      .toMatchObject({ method: 'messages.onlineSeats' })
  })
  it('rejects a body-supplied source and wildcard seat', () => {
    const input = send()
    expect(() => decodeRequest({ ...input, payload: { ...input.payload, sourceNodeId: 'forged' } })).toThrow()
    expect(() => decodeRequest({ ...input, sourceNodeId: 'forged' })).toThrow()
    expect(() => decodeRequest(send('*'))).toThrow()
    expect(() => decodeRequest(send('receiver?'))).toThrow()
  })
})
