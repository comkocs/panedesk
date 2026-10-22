import { describe, expect, it } from 'vitest'
import type { InitializeParams } from '@panedesk/dsh-sdk-protocol'
import { Context } from '@panedesk/cordis'
import AgentPresets from '@panedesk/dsh-agent-preset-registry'
import Loader from '@panedesk/cordis-plugin-loader'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import { ReasoningEffortId } from '@panedesk/dsh-llm'
import { executionPolicyDigest, validateHandshake } from '../src/handshake.ts'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'

const legacy = { cwd: '/workspace', provider: 'mock', model: 'mock' }

describe('optional SDK handshake validation', () => {
  it('canonicalizes keys but preserves array order and the internal rules digest', () => {
    expect(executionPolicyDigest({ b: 2, a: { y: 1, x: 0 } })).toBe(executionPolicyDigest({ a: { x: 0, y: 1 }, b: 2 }))
    expect(executionPolicyDigest({ tools: ['a', 'b'] })).not.toBe(executionPolicyDigest({ tools: ['b', 'a'] }))
    expect(executionPolicyDigest({ digest: 'one' })).not.toBe(executionPolicyDigest({ digest: 'two' }))
  })

  it.each(['version', 'digest', 'model'] as const)('rejects an installed policy %s mismatch before adapter resolution', async (field) => {
    const policy = { provider: 'mock', model: 'mock', reasoningEffort: 'high', allowedTools: [], rulesId: 'rules', version: '1', digest: 'rules-digest' }
    const digest = executionPolicyDigest(policy)
    const ctx = new Context()
    await ctx.plugin(Loader)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentPresets, { default: 'worker' })
    await ctx.agentPresets.register({ id: 'worker', plugins: [], executionPolicy: policy })
    const server = new HarnessSdkJsonRpcServer(ctx, { notify: () => {}, request: async () => ({}) })
    await expect(server.initialize({ ...legacy, model: field === 'model' ? 'other' : 'mock',
      reasoningEffort: ReasoningEffortId('high'), agentPreset: 'worker', executionPolicy: {
        presetId: 'worker', version: field === 'version' ? '2' : '1', digest: field === 'digest' ? 'b'.repeat(64) : digest,
      },
    })).rejects.toThrow(field === 'model' ? 'route does not match' : 'version or digest mismatch')
    await server.shutdown()
    await ctx.fiber.dispose()
  })

  it('accepts legacy clients and a complete new handshake', () => {
    expect(() => { validateHandshake(legacy) }).not.toThrow()
    expect(() => { validateHandshake({ ...legacy, agentPreset: 'worker',
      executionPolicy: { presetId: 'worker', version: '1', digest: 'a'.repeat(64) },
      ledgerContext: { seat: 'seat', window: 'window', nodeId: 'node', identitySource: 'inherited',
        parentSessionId: 'parent', rootSessionId: 'root', subagentRunId: 'run', parentRunId: 'parent-run', childSessionId: 'child' },
      cachePolicy: { retention: '1h' },
    }) }).not.toThrow()
  })

  it.each([
    { agentPreset: '' },
    { agentPreset: 'worker', executionPolicy: { presetId: 'other', version: '1', digest: 'a'.repeat(64) } },
    { agentPreset: 'worker', executionPolicy: { presetId: 'worker', version: '1', digest: 'bad' } },
    { ledgerContext: { seat: 'seat' } },
    { cachePolicy: { retention: 'forever' } },
  ])('rejects malformed optional fields before composition: %j', (fields) => {
    expect(() => { validateHandshake({ ...legacy, ...fields } as InitializeParams) }).toThrow()
  })
})
