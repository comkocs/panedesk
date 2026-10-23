import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@panedesk/dsh-brand'
import type { SubagentAdmission, SubagentQueued } from '@panedesk/dsh-subagent'
import { callSubagent, modelSelectionSetupAgent, setup, text } from './harness.ts'

describe('queued delegation', () => {
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
    ctx.provide('subagentAdmission', policy)
    const result = await callSubagent(ctx, { description: 'Queued work', prompt: 'Inspect files' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected queue acceptance')
    expect(result.value).toEqual({ kind: 'queued', ticketId: ticket.ticketId })
    expect(text(result)).toBe('queued subagent ticket-a; register a wait for this ticket and end the turn instead of retrying')
    expect(started).not.toHaveBeenCalled()
  })
})
