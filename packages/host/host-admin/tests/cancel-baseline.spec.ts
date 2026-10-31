/** Existing administrative frames remain byte-identical when cancellation is unused. */
import { expect, test } from 'vitest'
import { decodeRequest, decodeResponse } from '../src/codec.ts'
import { HOST_ADMIN_METHODS } from '../src/index.ts'

const frames = [
  ['node.status', '{}', '{"nodeId":"node-a","nodeName":"node-a","engine":"running","openEngineWindows":0,"limit":1,"readyAt":null}'],
  ['node.rebuild', '{}', '{"status":"rebuilt"}'],
  ['engine.pending', '{"limit":10}', '{"items":[],"watermark":0,"complete":true}'],
  ['engine.approve', '{"operationId":"operation-a","queueItemId":"queue-a","expectedStateVersion":1}', '{"status":"approved","queueItemId":"queue-a","stateVersion":2}'],
  ['engine.operation', '{"operationId":"operation-a"}', '{"status":"missing"}'],
  ['engine.query', '{"limit":10}', '{"effects":[],"complete":true,"watermark":0}'],
] as const

test('preserves the five baseline method request and response bytes without cancellation', () => {
  expect(HOST_ADMIN_METHODS.filter(method => method !== 'engine.cancel' && method !== 'engine.callbackResolve' && !method.startsWith('source.'))).toEqual(frames.map(([method]) => method))
  for (const [method, params, result] of frames) {
    const input = `{"version":"host-admin/v1","requestId":"request-a","processEpoch":"epoch-a","nonce":"nonce-a","method":"${method}","params":${params}}`
    const request = decodeRequest(JSON.parse(input))
    expect(JSON.stringify(request)).toBe(input)
    const output = `{"version":"host-admin/v1","requestId":"request-a","method":"${method}","status":"ok","result":${result}}`
    expect(JSON.stringify(decodeResponse(JSON.parse(output), request))).toBe(output)
    const refusal = `{"version":"host-admin/v1","requestId":"request-a","method":"${method}","status":"rejected","code":"admin-unauthorized","reason":"Administration authority rejected"}`
    expect(JSON.stringify(decodeResponse(JSON.parse(refusal), request))).toBe(refusal)
  }
})
