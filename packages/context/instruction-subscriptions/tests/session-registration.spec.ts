/** Per-session registrations own only their subscriptions and watcher lifetimes. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@panedesk/cordis'
import { describe, expect, it, vi } from 'vitest'
import { agentEvents } from '@panedesk/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@panedesk/dsh-agent-loop-testkit'
import { SessionId } from '@panedesk/dsh-session'
import MessageDelivery, { type SendMessageRequest, type SendMessageResult, type NodeId } from '@panedesk/dsh-message-delivery'
import * as Subscriptions from '../src/index.ts'

class DeliveryStub extends MessageDelivery {
  override send(_request: SendMessageRequest): Promise<SendMessageResult> { throw new Error('Unused') }
  override withdraw(): never { throw new Error('Unused') }
  override edit(): never { throw new Error('Unused') }
  override reprioritize(): never { throw new Error('Unused') }
  override invalidate(): never { throw new Error('Unused') }
  override status(): never { throw new Error('Unused') }
  override operationStatus(): never { throw new Error('Unused') }
  override list(): never { throw new Error('Unused') }
  override resolve(): never { throw new Error('Unused') }
  override sendBatch(): never { throw new Error('Unused') }
  override configure(): never { throw new Error('Unused') }
  override subscribe(): never { throw new Error('Unused') }
}

describe('session instruction registration', () => {
  it('registers only the exact session, shares path ownership and sends steer metadata without file contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-registration-'))
    const ctx = new Context()
    const sent: SendMessageRequest[] = []
    try {
      await writeFile(join(root, 'rules.md'), 'original private contents\n')
      await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
      const driver = await mountAgentLoopTestHarness(ctx)
      const delivery = new DeliveryStub(ctx)
      vi.spyOn(delivery, 'send').mockImplementation(async (request) => {
        sent.push(request)
        return { messageId: 'reminder-a' as SendMessageResult['messageId'], operationId: request.operationId,
          deliveryOutcome: 'accepted', messageState: 'queued', pending: false,
          recipient: { nodeId: 'node-a' as NodeId, sessionId: request.target.sessionId!,
            window: null, title: null, status: 'busy', matchedFields: ['sessionId'], observedAt: Date.now() } }
      })
      const closeWatcher = vi.fn(async () => {})
      const watch = vi.spyOn(ctx.fs, 'watch').mockImplementation(async () => closeWatcher)
      const plugin = await ctx.plugin(Subscriptions, { maxBytes: 4096, watch: true })
      const a = await driver.create(SessionId('window-a'), {}, { cwd: root })
      const b = await driver.create(SessionId('window-b'), {}, { cwd: root })
      vi.spyOn(a, 'status', 'get').mockReturnValue('running')
      vi.spyOn(b, 'status', 'get').mockReturnValue('running')
      const first = await ctx.instructionSubscriptions.register(a, ['rules.md', 'rules.md'])
      const second = await ctx.instructionSubscriptions.register(a, ['rules.md'])
      const boundary = async () => {
        for (const agent of [a, b]) await agentEvents(ctx, agent).serial('agent/input-preparing', {
          turn: 1, step: 1, signal: new AbortController().signal,
        })
      }
      await first()
      await writeFile(join(root, 'rules.md'), 'changed private contents\n')
      await boundary()
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ target: { sessionId: a.id }, messageClass: 'handoff', priority: 'steer' })
      expect(sent[0]!.content).not.toContain('private contents')
      expect(JSON.parse(sent[0]!.content)).toMatchObject({ kind: 'instruction-change', added: 1, removed: 1 })
      await second()
      await second()
      await writeFile(join(root, 'rules.md'), 'after disposal\n')
      await boundary()
      expect(sent).toHaveLength(1)
      expect(watch).toHaveBeenCalledOnce()
      expect(closeWatcher).toHaveBeenCalledOnce()
      await ctx.instructionSubscriptions.register(a, ['rules.md'])
      await ctx.instructionSubscriptions.register(b, ['rules.md'])
      expect(watch).toHaveBeenCalledTimes(3)
      await plugin.dispose()
      expect(closeWatcher).toHaveBeenCalledTimes(3)
      await writeFile(join(root, 'rules.md'), 'after plugin disposal\n')
      await boundary()
      expect(sent).toHaveLength(1)
    } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks() }
  })
})
