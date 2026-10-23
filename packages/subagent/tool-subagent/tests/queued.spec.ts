import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@panedesk/dsh-brand'
import type { SubagentAdmission, SubagentQueued } from '@panedesk/dsh-subagent'
import { valueSchemaSpecToJsonSchema } from '@panedesk/dsh-tools'
import { callSubagent, modelSelectionSetupAgent, setup, text } from './harness.ts'

// Output schema from the original activation-only tool definition.
const legacySchema = valueSchemaSpecToJsonSchema({
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'activation' },
    subagentId: { type: 'string', required: true },
  },
})

describe('queued delegation', () => {
  it('preserves activation-only schema and result bytes without admission', async () => {
    const ctx = await setup({ provider: 'mock' })
    const parent = modelSelectionSetupAgent(ctx)
    expect(JSON.stringify(ctx.tools.get('subagent')?.output.schema)).toBe(JSON.stringify(legacySchema))
    const result = await callSubagent(ctx, { description: 'Inspect files', prompt: 'Inspect files' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected activation')
    const childId = `scripted-subagent:mock:${parent.id}:1`
    expect(JSON.stringify(result.value)).toBe(JSON.stringify({ kind: 'activation', subagentId: childId }))
    expect(text(result)).toBe(`started subagent ${childId}`)
  })

  it('returns a ticket without creating a child or waiting for capacity', async () => {
    const started = vi.fn()
    const ctx = await setup({ provider: 'mock' }, { onStart: started })
    const parent = modelSelectionSetupAgent(ctx)
    const ticket: SubagentQueued = { status: 'queued', ticketId: brandString<SubagentQueued['ticketId']>('ticket-a'), parentSessionId: parent.id }
    const policy: SubagentAdmission = {
      acquire: async () => ticket,
      continue: async () => {},
      resume: async () => ticket,
    }
    const description = ctx.tools.get('subagent')?.description
    const removeAdmission = ctx.provide('subagentAdmission', policy)
    expect(ctx.tools.get('subagent')?.output.schema).toMatchObject({
      properties: { kind: { enum: ['activation', 'queued'] }, ticketId: { type: 'string' } },
    })
    const result = await callSubagent(ctx, { description: 'Queued work', prompt: 'Inspect files' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected queue acceptance')
    expect(result.value).toEqual({ kind: 'queued', ticketId: ticket.ticketId })
    expect(text(result)).toBe('queued subagent ticket-a; register a wait for this ticket and end the turn instead of retrying')
    expect(started).not.toHaveBeenCalled()
    removeAdmission()
    expect(JSON.stringify(ctx.tools.get('subagent')?.output.schema)).toBe(JSON.stringify(legacySchema))
    expect(ctx.tools.get('subagent')?.description).toBe(description)
  })
})
