import { describe, expect, it, vi } from 'vitest'
import { createUserMessage, ToolCallId } from '@panedesk/dsh-llm'
import type { SeatBinding } from '@panedesk/dsh-seat'
import type { SendMessageResult } from '@panedesk/dsh-message-delivery'
import { composition } from './composition.ts'
import * as plugin from '../src/index.ts'

function text(result: { content: readonly { type: string; text?: string }[] }) {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

describe('local seat message tools through Loader and production loops', () => {
  it('wakes an idle recipient, injects at the busy tool boundary, and records delivery and reading', async () => {
    const f = await composition(true)
    try {
      f.busy.followup(createUserMessage({ content: [{ type: 'text', text: 'Start work' }], source: { kind: 'user' } }))
      await f.entered.promise
      await vi.waitFor(async () => {
        expect(JSON.parse(text(await f.execute('seat_list_online', {})))).toEqual(expect.arrayContaining([
          expect.objectContaining({ seat: 'busy', sessionId: 'busy', nodeId: 'node-a', status: 'busy' }),
          expect.objectContaining({ seat: 'idle', sessionId: 'idle', nodeId: 'node-a', status: 'idle' }),
        ]))
      })
      f.read.binding = async () => ({ kind: 'seat', seat: 'sender-seat' } as SeatBinding)
      const idleSend = JSON.parse(text(await f.execute('seat_send', { seat: 'idle', text: 'Idle handoff' }))) as SendMessageResult
      expect(idleSend.deliveryOutcome).toBe('accepted')
      await vi.waitFor(() => { expect(f.adapter.requests.some(request => request.sessionId === 'idle')).toBe(true) })
      await f.idle.whenIdle()
      expect(f.adapter.requests.find(request => request.sessionId === 'idle')?.messages
        .find(message => message.id === idleSend.messageId)?.content).toMatchInlineSnapshot(`
          [
            {
              "text": "Seat "sender-seat":
          Idle handoff",
              "type": "text",
            },
          ]
        `)
      f.read.binding = async () => null
      const busySend = JSON.parse(text(await f.execute('seat_send', { seat: 'busy', text: 'Busy handoff' }))) as SendMessageResult
      expect(busySend.deliveryOutcome).toBe('accepted')
      await vi.waitFor(() => { expect(f.busy.inbox.nextStep.some(message => message.id === busySend.messageId)).toBe(true) })
      expect(f.adapter.requests.filter(request => request.sessionId === 'busy')).toHaveLength(1)
      f.release.resolve(undefined)
      await f.busy.whenIdle()
      const requests = f.adapter.requests.filter(request => request.sessionId === 'busy')
      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.some(message => message.id === busySend.messageId)).toBe(true)
      expect(JSON.stringify(requests[1]?.messages)).toContain('Free window')
      expect(f.busy.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
      expect(f.idle.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
      await vi.waitFor(async () => {
        const events = (await f.ctx.messageLedger.read({})).events
        for (const id of [idleSend.messageId, busySend.messageId]) {
          expect(events.filter(event => event.kind === 'message/state' && event.data.messageId === id
            && ['accepted', 'injected'].includes(event.data.transition))).toHaveLength(2)
        }
      })
    } finally { await f.close() }
  })
  it('refuses unopened and ambiguous seats and exposes no all-recipient tool', async () => {
    const f = await composition(true)
    try {
      expect(JSON.parse(text(await f.execute('seat_send', { seat: 'missing', text: 'Hello' }))))
        .toMatchObject({ kind: 'rejected', detail: 'seat not open' })
      f.windows[1] = { ...f.windows[1]!, seat: 'idle', primary: false }
      f.windows[2] = { ...f.windows[2]!, primary: false }
      expect(JSON.parse(text(await f.execute('seat_send', { seat: 'idle', text: 'Hello' }))))
        .toMatchObject({ kind: 'rejected', reason: 'target-ambiguous', detail: 'seat has no unique primary window' })
      expect((await f.execute('seat_send', { seat: '*', text: 'Hello' })).isError).toBe(true)
      expect((await f.execute('seat_send_all', { text: 'Hello' })).isError).toBe(true)
      expect(f.ctx.tools.schemas().filter(tool => tool.name.startsWith('seat_')).map(tool => tool.name).sort())
        .toEqual(['seat_list_online', 'seat_send'])
      expect((await f.ctx.messageLedger.read({})).events).toHaveLength(0)
    } finally { await f.close() }
  })
  it('keeps seat addressing disabled when the provider option is omitted', async () => {
    const f = await composition()
    try {
      const result = await f.execute('seat_send', { seat: 'idle', text: 'Disabled' })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('Seat addressing is disabled')
      expect((await f.execute('seat_list_online', {})).isError).toBe(true)
      expect((await f.ctx.messageLedger.read({})).events).toHaveLength(0)
      expect(f.adapter.requests).toHaveLength(0)
    } finally { await f.close() }
  })
  it('reports durable pending mail if the recipient closes after seat resolution without reopening it', async () => {
    const f = await composition(true)
    try {
      f.idle.followup(createUserMessage({ content: [{ type: 'text', text: 'Create durable history' }], source: { kind: 'user' } }))
      await vi.waitFor(() => { expect(f.idle.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(true) })
      await f.idle.whenIdle()
      const requestsBefore = f.adapter.requests.length
      f.read.binding = async () => {
        await f.idleHandle.dispose()
        return null
      }
      const result = JSON.parse(text(await f.execute('seat_send', { seat: 'idle', text: 'Closing handoff' }))) as SendMessageResult
      expect(result).toMatchObject({ deliveryOutcome: 'rejected', reason: 'target-closed-pending',
        messageState: 'queued', pending: true, recipient: { sessionId: 'idle', status: 'closed' } })
      expect(f.ctx.agents.get(f.idle.id)).toBeUndefined()
      expect(f.adapter.requests).toHaveLength(requestsBefore)
      expect((await f.ctx.messageDelivery.list({ targetSessionId: f.idle.id })).items)
        .toEqual([expect.objectContaining({ messageId: result.messageId, state: 'queued' })])
      expect((await f.ctx.messageLedger.read({})).events).toHaveLength(0)
    } finally { await f.close() }
  })
  it.each(['target', 'attribution'] as const)('rejects a repeated call after %s changes without publishing another message', async (change) => {
    const f = await composition(true)
    try {
      const callId = ToolCallId('repeated-send')
      const args = { seat: 'idle', text: 'One delivery' }
      const first = JSON.parse(text(await f.execute('seat_send', args, callId))) as SendMessageResult
      expect(first.deliveryOutcome).toBe('accepted')
      expect(JSON.parse(text(await f.execute('seat_send', args, callId)))).toEqual(first)
      if (change === 'target') {
        f.windows[2] = { ...f.windows[2]!, seat: 'former-idle' }
        f.windows[1] = { ...f.windows[1]!, seat: 'idle' }
      } else f.read.binding = async () => ({ kind: 'seat', seat: 'rebound-sender' } as SeatBinding)
      const retry = await f.execute('seat_send', args, callId)
      expect(retry.isError).toBe(true)
      expect(text(retry)).toContain('operation-conflict')
      expect((await f.ctx.messageDelivery.list({})).items).toEqual([
        expect.objectContaining({ messageId: first.messageId }),
      ])
    } finally { await f.close() }
  })
  it('removes registrations on plugin disposal', async () => {
    const f = await composition(true)
    try {
      const entry = [...f.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:messages')
      expect(entry?.fiber).toBeDefined()
      await entry!.fiber!.dispose()
      const fiber = await f.ctx.plugin(plugin)
      expect(f.ctx.tools.schemas().some(tool => tool.name === 'seat_send')).toBe(true)
      await fiber.dispose()
      expect(f.ctx.tools.schemas().some(tool => tool.name === 'seat_send')).toBe(false)
    } finally { await f.close() }
  })
})
