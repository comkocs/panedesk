import { describe, expect, it } from 'vitest'
import type { GateContext, GateDefinition } from '@panedesk/dsh-seat'
import { builtinCriterion, validateDefinitions } from '../src/policies.ts'
import { GateRegistry } from '../src/registry.ts'
import { config, policyContext, profile } from './harness.ts'

const base: GateContext = { hook: 'before-tool-call', callId: 'call-a' as GateContext['callId'],
  operationId: 'operation-a' as GateContext['operationId'], nodeId: 'node-a' as GateContext['nodeId'], seat: profile.seat,
  sessionId: null, observedAt: '2026-01-01T00:00:00Z', toolName: 'send', arguments: {}, hasPendingWork: false }
const row = (type: string): GateDefinition => ({ id: type as GateDefinition['id'], name: type, hook: 'before-tool-call',
  criterion: { type: type as GateDefinition['criterion']['type'], parameters: { maxBytes: 100 } },
  alternative: 'Review the complete outbound data.', expiresAt: null, enabled: true, revision: 1, order: 0 })

describe('validated builtin policies', () => {
  it('validates parameter bounds at activation and scans the complete outbound argument object', async () => {
    const { ctx, engine, effects } = policyContext()
    const definition = row('secret-scan')
    expect(() => {
      validateDefinitions([{ ...definition, criterion: { ...definition.criterion, parameters: { maxBytes: 0 } } }])
    }).toThrow()
    const registry = new GateRegistry(engine, [definition], Date.now)
    registry.register(builtinCriterion(ctx, config, 'secret-scan'))
    try {
      expect((await registry.evaluate({ ...base, arguments: { attachment: 'x'.repeat(100) } }))[0]).toMatchObject({ outcome: 'deny' })
      expect((await registry.evaluate({ ...base, callId: 'call-b' as GateContext['callId'], arguments: { text: 'safe' } }))[0])
        .toMatchObject({ outcome: 'allow' })
      expect(effects[0]?.kind).toBe('gate/hit')
      if (effects[0]?.kind === 'gate/hit' && effects[0].data.context.hook === 'before-tool-call') {
        expect(effects[0].data.context.arguments).toEqual({ redacted: true })
      }
    } finally { await ctx.fiber.dispose() }
  })
  it('tightens polling thresholds from the seat profile and refuses repeated history cursors', async () => {
    const { ctx, engine } = policyContext({ ...profile, pollingThreshold: 1, maxSleepSeconds: 5 })
    const criterion = builtinCriterion(ctx, config, 'polling')
    try {
      expect(await criterion.evaluate({ ...base, toolName: 'bash', arguments: { command: 'sleep 6' } }, row('polling')))
        .toMatchObject({ outcome: 'deny', reason: { code: 'sleep-limit-exceeded' } })
      engine.query = async () => ({ effects: [], watermark: 0, complete: false,
        nextCursor: { nodeId: base.nodeId, sequence: 0, effectIndex: 0 } })
      await expect(criterion.evaluate(base, row('polling'))).rejects.toThrow('incomplete')
    } finally { await ctx.fiber.dispose() }
  })
})
