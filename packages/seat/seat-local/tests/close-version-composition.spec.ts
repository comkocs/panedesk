/** Stale close requests retain runtime busy evidence without bypassing admission. */
import { expect, it } from 'vitest'
import { createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@panedesk/dsh-llm'
import type { JobOutcome } from '@panedesk/dsh-jobs'
import type { ListSeatWindowsResult } from '@panedesk/dsh-seat'
import * as Tools from '../../tool-seat/src/index.ts'
import { completesIdleTurn } from '../../seat/tests/completion.ts'
import { admissionHost } from './admission-host.ts'
import { operation } from './fixtures.ts'

type Host = Awaited<ReturnType<typeof admissionHost>>
async function openWindow(f: Host) {
  const opened = await f.seats.open({ seat: f.definition.seat, origin: 'manual', openingMode: 'prefill',
    operationId: operation('open-window') })
  if (opened.status !== 'prefilled') throw new Error(JSON.stringify(opened))
  return opened.sessionId
}
async function windowSnapshot(f: Host) {
  const listed = await f.seats.list({})
  if (listed.status !== 'listed' || !listed.sessions[0]) throw new Error(JSON.stringify(listed))
  return listed.sessions[0]
}
async function expectUnchanged(f: Host, sessionId: Awaited<ReturnType<typeof openWindow>>, title: string) {
  expect(f.ctx.workspaceRegistry.archivedSessionIds).not.toContain(sessionId)
  expect(f.ctx.sessionTitle.get(f.ctx.sessions.get(sessionId)!)?.title).toBe(title)
  expect((await f.state.read()).effects.filter(effect => effect.kind === 'window/closing'
    || effect.kind === 'window/closed' || effect.kind === 'resource/released')).toEqual([])
}

it('returns current job busy reasons with a stale close conflict and preserves the window', async () => {
  const f = await admissionHost()
  const done = Promise.withResolvers<JobOutcome>()
  try {
    const sessionId = await openWindow(f)
    const before = await windowSnapshot(f)
    f.ctx.jobs.attachController('close-observer')
    const jobId = f.ctx.jobs.start({ kind: 'bash', label: 'Background work', owner: sessionId,
      run: () => ({ done: done.promise, cancel: () => { done.resolve({ status: 'killed' }) } }) })
    const current = await windowSnapshot(f)
    const staleVersion = current.stateVersion - 1
    expect(await f.seats.close({ sessionId, expectedStateVersion: staleVersion,
      operationId: operation('stale-busy') })).toEqual({ status: 'conflict', expectedStateVersion: staleVersion,
      actualStateVersion: current.stateVersion, busyReasons: current.busyReasons })
    expect(current.busyReasons).toContainEqual({ kind: 'job', objectId: jobId, summary: `job: ${jobId}` })
    expect(await f.seats.close({ sessionId, expectedStateVersion: current.stateVersion,
      operationId: operation('current-busy') })).toEqual({ status: 'busy', sessionId, busyReasons: current.busyReasons })
    await expectUnchanged(f, sessionId, before.title)
  } finally { done.resolve({ status: 'killed' }); await f.close() }
})

it('keeps stale idle closes conflicting and closes only with the current version', async () => {
  const f = await admissionHost()
  try {
    const sessionId = await openWindow(f)
    const current = await windowSnapshot(f)
    expect(current.busyReasons).toEqual([])
    const staleVersion = current.stateVersion - 1
    expect(await f.seats.close({ sessionId, expectedStateVersion: staleVersion,
      operationId: operation('stale-idle') })).toEqual({ status: 'conflict', expectedStateVersion: staleVersion,
      actualStateVersion: current.stateVersion })
    await expectUnchanged(f, sessionId, current.title)
    expect(await f.seats.close({ sessionId, expectedStateVersion: current.stateVersion,
      operationId: operation('current-idle') })).toMatchObject({ status: 'closed', sessionId })
    expect(f.ctx.workspaceRegistry.archivedSessionIds).toContain(sessionId)
    expect(f.ctx.sessionTitle.get(f.ctx.sessions.get(sessionId)!)?.title).toBe(`${current.title} closed`)
    expect((await f.state.read()).effects.filter(effect => effect.kind === 'resource/released')).toHaveLength(1)
  } finally { await f.close() }
})

it('returns turn busy reasons when a model closes its own running window using seat_windows version', async () => {
  const f = await admissionHost()
  try {
    f.ctx.loader.builtins.tools = Tools
    await f.load('close-tools.yml', [{ name: 'cordis:tools', config: {} }])
    const sessionId = await openWindow(f)
    const before = await windowSnapshot(f)
    let stage = 0
    let expectedVersion: number | undefined
    let modelResult: object | undefined
    const original = f.adapter.stream.bind(f.adapter)
    f.adapter.stream = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
      const result = options.messages.findLast(message => message.role === 'tool')
      const text = result?.content.filter(block => block.type === 'text').map(block => block.text).join('')
      let call: { name: string; arguments: object }
      if (stage === 0) call = { name: 'seat_windows', arguments: {} }
      else if (stage === 1) {
        const listed = JSON.parse(text ?? '') as ListSeatWindowsResult
        if (listed.status !== 'listed') throw new Error(JSON.stringify(listed))
        const own = listed.sessions.find(window => window.sessionId === sessionId)
        if (!own) throw new Error('Calling window was not listed')
        expectedVersion = own.stateVersion
        call = { name: 'seat_close', arguments: { sessionId, expectedStateVersion: expectedVersion } }
      } else {
        modelResult = JSON.parse(text ?? '') as object
        yield* original(options)
        return
      }
      stage++
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`close-${stage}`),
        name: call.name, arguments: JSON.stringify(call.arguments) } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
    const agent = f.ctx.agents.get(sessionId)!
    await completesIdleTurn(f.ctx, agent, () => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'List windows, then close this window.' }], source: { kind: 'user' } }))
    })
    expect(stage).toBe(2)
    expect(modelResult).toMatchObject({ status: 'conflict', expectedStateVersion: expectedVersion,
      busyReasons: [{ kind: 'turn', summary: 'A turn is running.' }] })
    if (!modelResult || !('actualStateVersion' in modelResult)) throw new Error('Missing conflict watermark')
    expect(modelResult.actualStateVersion).toBeGreaterThan(expectedVersion!)
    await f.ctx.sessions.flush(agent.session)
    const snapshot = await f.ctx.sessionQuery.readSession(sessionId)
    const persisted = snapshot.events.findLast(event => event.type === 'tool/result')
    if (persisted?.type !== 'tool/result') throw new Error('Missing durable close result')
    expect(JSON.parse(persisted.data.message.content.filter(block => block.type === 'text').map(block => block.text).join(''))).toEqual(modelResult)
    await expectUnchanged(f, sessionId, before.title)
  } finally { await f.close() }
}, 30000)
