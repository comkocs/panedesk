import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import { agentEvents } from '@panedesk/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@panedesk/dsh-agent-loop-testkit'
import Delivery from '@panedesk/dsh-message-delivery-local'
import Ledger from '@panedesk/dsh-session-ledger'
import * as Persistence from '@panedesk/dsh-session-persistence-jsonl'
import * as Subscriptions from '@panedesk/dsh-instruction-subscriptions'
import { SessionId } from '@panedesk/dsh-session'
import { expect, it, vi } from 'vitest'
import { registerSubscriptions } from '../src/subscriptions.ts'
import { createLocalRuntime } from '../src/runtime.ts'
import { definition, nodeId, operation } from './fixtures.ts'
import { insertsInput, inputContains } from '../../seat/tests/completion.ts'

it('deduplicates durable delivery and sends Session subscription reminders until disposal', async () => {
  const root = await mkdtemp(join(process.env.PANEDESK_TEST_TEMP_ROOT ?? process.cwd(), 'seat-delivery-'))
  const ctx = new Context()
  vi.stubEnv('PANEDESK_HOME', root)
  vi.stubEnv('PANEDESK_AGENTS_HOME', join(root, 'agents'))
  try {
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, persistence: Persistence, ledger: Ledger,
      delivery: Delivery, subscriptions: Subscriptions })
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    const path = join(root, 'cordis.yml')
    await writeFile(path, JSON.stringify([
      { name: 'cordis:persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
      { name: 'cordis:ledger', config: { dshHome: root } },
      { name: 'cordis:delivery', config: { dshHome: root, maxRecordBytes: 1048576, maxContentBytes: 65536,
        maxBatchSize: 100, scanIntervalMs: 1000, lockTimeoutMs: 5000, lockRetryMs: 1, watch: false } },
      { name: 'cordis:subscriptions', config: { maxBytes: 65536, watch: false } },
    ]))
    const entry = await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    const driver = await mountAgentLoopTestHarness(ctx)
    ctx.on('agent/turn-admitting', () => ({ kind: 'defer', reason: 'Queue inspection owns this test turn.' }))
    const agent = await driver.create(SessionId('seat-a'), {}, { cwd: root })
    vi.spyOn(agent, 'status', 'get').mockReturnValue('running')
    const file = join(root, 'rules.md')
    await writeFile(file, 'rule one\n')
    const dispose = await registerSubscriptions(ctx.get('instructionSubscriptions'), agent, [file])
    const runtime = createLocalRuntime(ctx, { directory: root, nodeId, nodeName: 'node-a', nodeAliases: {},
      defaults: definition(root), maxSourceBytes: 65536, maxPlans: 20, maxOpeningBytes: 65536,
      maxBatchSeats: 10, pageSize: 100, transactionRetries: 10, maxConfirmations: 10, closedSuffix: ' closed' })
    const request = { sessionId: agent.id, operationId: operation('wake-a'), text: 'Resume the assigned work.', mode: 'steer' as const }
    const first = await insertsInput(ctx, agent.id, inputContains(request.text), () => runtime.send(request))
    expect(await runtime.send(request)).toEqual(first)
    const delivery = ctx.get('messageDelivery')
    if (delivery === undefined) throw new Error('Delivery composition is unavailable')
    expect(await delivery.status(first.messageId)).toMatchObject({ state: 'queued' })
    const boundary = () => agentEvents(ctx, agent).serial('agent/input-preparing', {
      turn: 1, step: 1, signal: new AbortController().signal,
    })
    await boundary()
    expect(agent.inbox.nextStep.filter(item => item.id === first.messageId)).toHaveLength(1)
    const sent = vi.spyOn(delivery, 'send')
    await insertsInput(ctx, agent.id, inputContains('instruction-change'), async () => {
      await writeFile(file, 'rule two\n')
      await boundary()
    })
    const reminderRequest = sent.mock.calls.find(([request]) => request.content.includes('instruction-change'))?.[0]
    expect(reminderRequest?.messageClass).toBe('handoff')
    expect(reminderRequest?.priority).toBe('steer')
    await boundary()
    expect(agent.inbox.nextStep.filter(item => JSON.stringify(item).includes('instruction-change'))).toHaveLength(1)
    const reminders = agent.inbox.nextStep.filter(item => JSON.stringify(item).includes('instruction-change'))
    expect(reminders).toHaveLength(1)
    expect(JSON.stringify(reminders)).not.toContain('rule two')
    await dispose()
    await writeFile(file, 'rule three\n')
    await boundary()
    expect(agent.inbox.nextStep.filter(item => JSON.stringify(item).includes('instruction-change'))).toHaveLength(1)
    await ctx.loader.resolve(entry).fiber?.dispose()
    expect(ctx.get('instructionSubscriptions')).toBeUndefined()
    expect(ctx.get('messageDelivery')).toBeUndefined()
  } finally {
    vi.restoreAllMocks()
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
