import { afterEach, expect, it } from 'vitest'
import { readFile, writeFile, mkdtemp, rm, readdir, mkdir } from 'node:fs/promises'
import type { ChildAdmissionTicket, EngineEffect, GateDefinition, SeatTrigger } from '@panedesk/dsh-seat'
import { openingFacts, recordCost } from './fixtures/ledger.ts'
import { LocalSeatService } from '@panedesk/dsh-seat-local'
import { digest } from '@panedesk/dsh-seat-local/src/store.ts'
import { clock, measured } from './fixtures/clock.ts'
import { createUserMessage, ToolCallId } from '@panedesk/dsh-llm'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { fixture, operation, seatName, childFixture, type Fixture } from './fixtures/source.ts'

const active: Fixture[] = []
afterEach(async () => { for (const f of active.splice(0)) await f.close() })
async function setup(options: Parameters<typeof fixture>[0] = {}) { const f = await fixture(options); active.push(f); return f }

it('A01 imports selected neutral rows with exact source hashes and diagnostics', async () => {
  const f = await setup()
  const sourcePath = join(f.home, 'source.csv')
  const content = await readFile(new URL('./fixtures/seat-table.csv', import.meta.url), 'utf8')
  await writeFile(sourcePath, content)
  const request = { format: 'csv' as const, sourcePath, columnMap: { seat: 'seat', model: 'model', keep: 'autoKeepAlive' }, defaults: {} }
  const plan = await f.seats.previewImport(request)
  expect(plan).toHaveProperty('planId')
  if (!('planId' in plan)) throw new Error(JSON.stringify(plan))
  expect(plan.sourceFileHash).toBe(createHash('sha256').update(content).digest('hex'))
  expect(plan.rows.map(row => [row.seat, row.selected, row.diagnostics])).toEqual([['seat-a', true, []], ['seat-b', true, []]])
  expect(plan.rows[0]?.definition?.model).toBe('model,a\nline')
  expect((await f.seats.definitions({})).definitions).toHaveLength(0)
  expect(await f.seats.commitImport({ planId: plan.planId, selectedRows: [plan.rows[1]!.row], expectedRevision: 0,
    operationId: operation() })).toMatchObject({ status: 'committed' })
  expect((await f.seats.definitions({})).definitions).toMatchObject([{ seat: 'seat-b', source: { sourceFileHash: plan.sourceFileHash } }])
  await writeFile(sourcePath, await readFile(new URL('./fixtures/seat-table.md', import.meta.url), 'utf8'))
  const markdown = await f.seats.previewImport({ ...request, format: 'markdown' })
  if (!('planId' in markdown)) throw new Error(JSON.stringify(markdown))
  expect(markdown.rows[0]?.definition?.model).toBe('model|a')
  await writeFile(sourcePath, 'seat\nseat-a\nseat-a\n')
  const invalid = await f.seats.previewImport({ ...request, columnMap: { seat: 'seat' } })
  if (!('planId' in invalid)) throw new Error(JSON.stringify(invalid))
  expect(invalid.rows.map(row => [row.action, row.selected])).toEqual([['invalid', false], ['invalid', false], ['tombstone', false]])
}, 20000)

it('A01 recomputes every normalized row and column digest independently from neutral input', async () => {
  const f = await setup()
  const sourcePath = join(f.home, 'neutral-import.csv')
  const content = 'seat,model,keep\nseat-a,model-a,true\nseat-b,model-b,false\n'
  await writeFile(sourcePath, content)
  const plan = await f.seats.previewImport({ sourcePath, format: 'csv',
    columnMap: { seat: 'seat', model: 'model', keep: 'autoKeepAlive' }, defaults: {} })
  if (!('planId' in plan)) throw new Error(JSON.stringify(plan))
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    return JSON.stringify(value)
  }
  const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
  expect(plan.rows).toHaveLength(2)
  expect(plan.sourceFileHash).toBe(createHash('sha256').update(content).digest('hex'))
  for (const row of plan.rows) {
    const baseline = row.definition?.source?.baseline
    expect(baseline).toBeDefined()
    expect(row.rowHash).toBe(hash(baseline))
    expect(row.columnHashes).toEqual(Object.fromEntries(Object.entries(baseline!).map(([key, value]) => [key, hash(value)])))
    expect(row.diagnostics).toEqual([])
  }
  expect(plan.rows.map(row => row.definition?.autoKeepAlive)).toEqual([true, false])
  expect(await f.ctx.sessionPersistence.list()).toHaveLength(0)
}, 20000)

it('A02 preserves whole-seat conflicts, stale previews and exclusive source authority', async () => {
  const f = await setup()
  const sourcePath = join(f.home, 'source.csv')
  const request = { format: 'csv' as const, sourcePath, columnMap: { seat: 'seat', model: 'model' }, defaults: {} }
  await writeFile(sourcePath, 'seat,model\nseat-a,model-a\nseat-b,model-a\n')
  const plan = await f.seats.previewImport(request)
  if (!('planId' in plan)) throw new Error(JSON.stringify(plan))
  expect(await f.seats.commitImport({ planId: plan.planId, selectedRows: plan.rows.map(row => row.row), expectedRevision: 0,
    operationId: operation() })).toMatchObject({ status: 'committed' })
  const original = (await f.seats.definitions({})).definitions[0]!
  expect(await f.seats.save({ definition: { ...original, model: 'model-local' }, expectedRevision: 1, operationId: operation() }))
    .toMatchObject({ status: 'rejected', error: { code: 'import-source-authoritative' } })
  expect(await f.seats.setAuthority({ authority: 'seat-store', expectedRevision: 1, authorizationRef: 'owner' as never,
    operationId: operation() })).toMatchObject({ status: 'saved' })
  expect(await f.seats.save({ definition: { ...original, model: 'model-local' }, expectedRevision: 2, operationId: operation() }))
    .toMatchObject({ status: 'saved' })
  const frozen = await f.seats.previewImport(request)
  if (!('planId' in frozen)) throw new Error(JSON.stringify(frozen))
  expect(await f.seats.commitImport({ planId: frozen.planId, selectedRows: frozen.rows.map(row => row.row),
    expectedRevision: 3, operationId: operation() })).toMatchObject({ status: 'rejected', error: { code: 'seat-store-authoritative' } })
  expect(await f.seats.setAuthority({ authority: 'import-source', expectedRevision: 3, authorizationRef: 'owner' as never,
    operationId: operation() })).toMatchObject({ status: 'saved' })
  await writeFile(sourcePath, 'seat,model\nseat-a,model-source\nseat-b,model-source\n')
  const changed = await f.seats.previewImport(request)
  if (!('planId' in changed)) throw new Error(JSON.stringify(changed))
  expect(changed.rows[0]).toMatchObject({ action: 'conflict', selected: false })
  expect(changed.rows[0]?.differences).toContainEqual({ field: 'model', baseline: 'model-a', local: 'model-local', source: 'model-source', conflict: true })
  expect(changed.rows[1]?.action).toBe('update')
  expect(await f.seats.commitImport({ planId: changed.planId, selectedRows: changed.rows.map(row => row.row), expectedRevision: 4,
    operationId: operation() })).toMatchObject({ status: 'committed' })
  expect((await f.seats.definitions({})).definitions.map(def => def.model)).toEqual(['model-local', 'model-source'])
  const stale = await f.seats.previewImport(request)
  if (!('planId' in stale)) throw new Error(JSON.stringify(stale))
  await writeFile(sourcePath, 'seat,model\nseat-a,model-new\n')
  expect(await f.seats.commitImport({ planId: stale.planId, selectedRows: [], expectedRevision: stale.baseRevision,
    operationId: operation() })).toMatchObject({ status: 'rejected', error: { code: 'import-preview-stale' } })
}, 20000)

it('A03 assembles CLI, SDK, remote and engine openings with one durable first message', async () => {
  const f = await setup()
  const def = f.definition('seat-a', { maxOpenSessions: 4, rules: [{ id: 'rule-a' as never, enabled: true,
    trigger: { kind: 'external', sourceId: f.sourceId }, timeWindows: [], exclusiveTags: [] }] })
  await f.save(def)
  const { executeSeatCommand } = await import('../src/cli.ts')
  const cli = await executeSeatCommand(f.ctx, ['open', '--seat', 'seat-a', '--opening', 'auto', '--operation', 'cli-a'])
  expect(cli, JSON.stringify(cli)).toMatchObject({ code: 0, output: { status: 'opened' } })
  await f.open()
  const remote = f.ctx.seats.withAuthority({ principalId: 'owner' as never, origin: 'remote', nodeId: f.nodeId })
  expect(await remote.open({ seat: seatName('seat-a'), origin: 'remote', operationId: operation() })).toMatchObject({ status: 'opened' })
  expect(await f.engine.setProjectMode({ projectId: def.projectId, mode: 'auto', expectedRevision: 0, operationId: operation() })).toMatchObject({ status: 'saved' })
  expect(await f.engine.accept(f.trigger())).toMatchObject({ status: 'accepted' })
  await f.engine.drive()
  await f.settle()
  const list = await f.seats.list({})
  if (list.status !== 'listed') throw new Error(JSON.stringify(list))
  expect(list.sessions).toHaveLength(4)
  for (const window of list.sessions) {
    expect(window.title).toBe(`seat-a ${new Date().toISOString().slice(5, 10)}`)
    expect(await f.seats.binding({ sessionId: window.sessionId })).toMatchObject({ kind: 'seat', seat: 'seat-a',
      directories: def.directories, memoryDirectories: def.memoryDirectories, subscriptions: def.subscriptions })
    expect((await f.ctx.sessionPersistence.stat(window.sessionId))?.header.cwd).toBe(def.directories[0]?.path)
    const session = f.ctx.agents.get(window.sessionId)!.session
    const open = openingFacts(await f.effects()).find(item => item.sessionId === window.sessionId)
    if (open?.openingMessageId == null) throw new Error(JSON.stringify(open))
    const delivered = session.snapshotEvents().flatMap((event) => {
      if (event.type !== 'user/message' || event.data.source.kind !== 'message-delivery') return []
      return String(event.data.source.operationId) === String(digest(open.openingOperationId)) ? [event] : []
    })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.data.id).toBe(open.openingMessageId)
    expect(JSON.stringify(delivered[0]?.data.content)).toContain('Open seat-a')
    expect(session.snapshotEvents()).toContainEqual(expect.objectContaining({ type: 'permission/preset', data: { preset: def.permissionPreset } }))
    const runs = (await f.ctx.sessionLedger.query({ sessionId: window.sessionId })).rows.filter(row => row.kind === 'run')
    expect(runs).toHaveLength(1)
    expect(runs[0]?.start).toMatchObject({ seat: 'seat-a', identitySource: 'settings', window: window.title })
  }
  expect(f.model.requests).toHaveLength(4)
  expect(f.model.requests.every(request => JSON.stringify(request).includes('Open seat-a'))).toBe(true)
}, 20000)

it('A04 rejects a foreign owned directory before creating any physical session', async () => {
  const f = await setup()
  await f.save(f.definition('seat-a'))
  const other = f.definition('seat-b', { directories: [{ path: join(f.home, 'workspace-b'), startup: true }] })
  await f.save(other)
  const request = { cwd: other.directories[0]!.path, seat: seatName('seat-a'), interactive: false }
  const choice = await f.seats.resolveDirectoryChoice(request)
  expect(choice).toMatchObject({ status: 'choice-required', candidates: ['seat-b'], choices: ['open-seat', 'traditional', 'cancel'] })
  expect(JSON.stringify(choice)).toContain('dsh --profile seat open --seat')
  const creation = await f.ctx.sessionController.create({ sessionId: 'foreign-window' as never, cwd: request.cwd })
    .then(() => 'created', () => 'rejected')
  expect(creation).toBe('rejected')
  expect(f.ctx.agents.list()).toHaveLength(0)
  expect(await f.ctx.sessionPersistence.stat('foreign-window' as never)).toBeUndefined()
  expect(f.model.requests).toHaveLength(0)
}, 20000)

it('A05 lists shared candidates and creates unowned traditional sessions without a seat binding', async () => {
  const f = await setup()
  await f.save(f.definition('seat-a'))
  await f.save(f.definition('seat-b'))
  expect(await f.seats.resolveDirectoryChoice({ cwd: join(f.home, 'workspace-a'), interactive: true }))
    .toMatchObject({ status: 'choice-required', candidates: ['seat-a', 'seat-b'], choices: ['open-seat', 'traditional', 'cancel'] })
  const cwd = join(f.home, 'workspace-b')
  expect(await f.seats.resolveDirectoryChoice({ cwd, interactive: false })).toEqual({ status: 'allowed', identity: 'free' })
  const { sessionId } = await f.ctx.sessionController.create({ sessionId: 'free-window' as never, cwd })
  const agent = f.ctx.agents.get(sessionId)!
  expect(await f.seats.binding({ sessionId: agent.id })).toMatchObject({ kind: 'free' })
  const list = await f.seats.list({})
  expect(list).toMatchObject({ status: 'listed', sessions: [], unopenedSeats: ['seat-a', 'seat-b'] })
  expect((await f.ctx.sessionPersistence.stat(agent.id))?.header.cwd).toBe(cwd)
}, 20000)

it('A06 blocks foreign and free memory writes while retaining own and shared file access', async () => {
  const f = await setup()
  await f.save(f.definition('seat-a'))
  await f.save(f.definition('seat-b', { directories: [{ path: join(f.home, 'workspace-b'), startup: true }], memoryDirectories: [join(f.home, 'memory-b')] }))
  const opened = await f.open()
  await f.settle()
  const roots = await f.ctx.seatDirectories.roots(opened.sessionId)
  for (const path of ['memory-a', 'memory-shared']) {
    const root = roots.find(item => item.path === join(f.home, path))!
    expect(root).toBeDefined()
    expect(await f.ctx.seatDirectories.write({ sessionId: opened.sessionId, rootId: root.rootId,
      relativePath: 'note.txt', content: 'Neutral note.', operationId: operation() })).toMatchObject({ status: 'written' })
    expect(await readFile(join(f.home, path, 'note.txt'), 'utf8')).toBe('Neutral note.')
    expect(await f.ctx.seatDirectories.read({ sessionId: opened.sessionId, rootId: root.rootId, relativePath: 'note.txt', maxBytes: 100 }))
      .toMatchObject({ status: 'read', content: 'Neutral note.' })
  }
  const base = { callId: 'memory-call' as never, operationId: operation(), nodeId: f.nodeId,
    sessionId: opened.sessionId, observedAt: new Date().toISOString(), hook: 'before-memory-write' as const,
    targetPath: join(f.home, 'memory-b', 'note.txt'), authorizedDirectories: [], syntax: 'certain' as const }
  for (const seat of [seatName('seat-a'), null]) {
    const denied = await f.ctx.seatGates.evaluate({ ...base, callId: 'memory-gate' as never, seat })
    expect(denied.filter(item => item.outcome === 'deny').map(item => item.reason.code)).toContain('memory-seat-mismatch')
    expect(JSON.stringify(denied)).toContain(seat ? 'memory-a' : 'owning seat')
  }
}, 20000)

it.each(['write', 'edit'] as const)('A06 enforces memory ownership through the real %s tool executor', async (name) => {
  const f = await setup()
  await f.save(f.definition())
  await f.save(f.definition('seat-b', { memoryDirectories: [join(f.home, 'memory-b')] }))
  const opened = await f.open()
  const agent = f.ctx.agents.get(opened.sessionId)!
  await agent.whenIdle()
  for (const root of ['memory-b', 'memory-a', 'memory-shared']) {
    const path = join(f.home, root, 'note.txt')
    await writeFile(path, 'Before.')
    const args = name === 'write' ? { file_path: path, content: 'After.' } : { file_path: path, old_string: 'Before.', new_string: 'After.' }
    const result = await f.ctx.agents.withInitiator(agent, () => f.ctx.tools.execute({ name, arguments: args, agent,
      callId: ToolCallId(`file-${name}-${root}`), signal: new AbortController().signal }))
    expect(result.isError, JSON.stringify(result)).toBe(root === 'memory-b')
    expect(await readFile(path, 'utf8')).toBe(root === 'memory-b' ? 'Before.' : 'After.')
    if (root === 'memory-b') expect(JSON.stringify(result)).toContain('memory')
  }
}, 20000)

it('A07 refuses occupied remote and engine seats and keeps concurrent openings within the limit', async () => {
  const f = await setup()
  await f.save(f.definition())
  await f.open()
  await f.settle()
  expect(await f.seats.open({ seat: seatName('seat-a'), origin: 'manual', operationId: operation() }))
    .toMatchObject({ status: 'choice-required', choices: ['switch', 'replace', 'cancel'], defaultChoice: 'switch' })
  const remote = f.ctx.seats.withAuthority({ principalId: 'owner' as never, origin: 'remote', nodeId: f.nodeId })
  expect(await remote.open({ seat: seatName('seat-a'), origin: 'remote', operationId: operation() }))
    .toMatchObject({ status: 'rejected', error: { code: 'seat-already-open' } })
  await f.save(f.definition('seat-b', { maxOpenSessions: 2, directories: [{ path: join(f.home, 'workspace-b'), startup: true }] }))
  const results = await Promise.all(Array.from({ length: 3 }, () => remote.open({ seat: seatName('seat-b'), origin: 'remote', operationId: operation() })))
  expect(results.filter(result => result.status === 'opened')).toHaveLength(2)
  expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ error: { code: 'seat-already-open' } }])
  expect(f.ctx.agents.list()).toHaveLength(3)
}, 20000)

it.each(['open/intent', 'open/created', 'open/configured'])('A09 recovers a real Loader child after SIGKILL at %s', async (stage) => {
  const home = await mkdtemp(join(process.cwd(), '.acceptance-recovery-'))
  const children: ReturnType<typeof childFixture>[] = []
  try {
    const first = childFixture(home, stage); children.push(first)
    expect(first.pid).toBeTypeOf('number')
    await first.ready
    await first.stop()
    expect(await first.exited).toEqual([null, 'SIGKILL'])
    const recovered = childFixture(home, 'recover'); children.push(recovered)
    await recovered.ready
    const result: { effects: EngineEffect[]; physical: { sessionId: string; exists: boolean }[]; milliseconds: number } =
      JSON.parse(await readFile(join(home, 'recovery.json'), 'utf8')) as typeof result
    console.log(JSON.stringify({ name: `A09 ${stage}`, milliseconds: result.milliseconds }))
    const opens = openingFacts(result.effects)
    expect(opens).toHaveLength(1)
    expect(result.physical).toEqual([{ sessionId: opens[0]!.sessionId, exists: true }])
    expect(new Set(result.effects.filter(effect => effect.kind === 'open/configured').map(effect => effect.data.openingOperationId)).size).toBe(1)
    expect(opens[0]!.phase).toBe('active')
  } finally {
    for (const child of children) await child.stop()
    await rm(home, { recursive: true, force: true })
  }
}, 30000)

it('A09 preserves a torn journal tail and refuses a corrupt complete middle frame on real Loader restart', async () => {
  const home = await mkdtemp(join(process.cwd(), '.acceptance-journal-'))
  let current: Fixture | undefined
  try {
    current = await fixture({ home, preserve: true })
    await current.save(current.definition())
    await current.engine.accept(current.trigger())
    const nodeId = current.nodeId
    const before = await current.effects()
    await current.close(); current = undefined
    const root = join(home, 'ledger', 'engine', 'v1', nodeId, 'events')
    const fragment = join(root, '9999999999999999-tail.jsonl')
    await writeFile(fragment, '{"namespace":')
    current = await fixture({ home, preserve: true })
    expect(await current.effects()).toEqual(before)
    expect(await readFile(fragment, 'utf8')).toBe('{"namespace":')
    await current.close(); current = undefined
    const first = (await readdir(root)).filter(name => name.endsWith('.jsonl') && !name.startsWith('999')).sort()[0]!
    await writeFile(join(root, first), '{"broken":true}\n')
    const failure = await fixture({ home, preserve: true }).then(async (loaded) => { await loaded.close(); return null },
      (error: unknown) => error instanceof Error ? error.message : String(error))
    expect(failure).not.toBeNull()
    expect(await readFile(join(root, first), 'utf8')).toBe('{"broken":true}\n')
  } finally { await current?.close(); await rm(home, { recursive: true, force: true }) }
}, 20000)

const triggerKinds: SeatTrigger['kind'][] = ['schedule', 'git', 'external', 'window-ended', 'handoff-timeout', 'manual']
it.each(triggerKinds.flatMap(kind => (['off', 'remind', 'auto'] as const).map(mode => ({ kind, mode }))))(
  'A08 routes $kind under $mode without unintended windows', async ({ kind, mode }) => {
    const f = await setup()
    const def = f.definition()
    await f.save(def)
    await f.engine.setProjectMode({ projectId: def.projectId, mode, expectedRevision: 0, operationId: operation() })
    const envelope = f.trigger(kind)
    let existing = 0
    if (envelope.evidence.kind === 'handoff-timeout') {
      for (const sessionId of ['sender-a', 'recipient-a']) await f.ctx.sessionCreation.create({ sessionId: sessionId as never, cwd: join(f.home, 'workspace-b') })
      const sent = await f.ctx.messageDelivery.send({ target: { sessionId: 'recipient-a' as never }, content: 'Pending handoff.',
        messageClass: 'handoff', priority: 'queue', operationId: operation() as never })
      envelope.evidence = { ...envelope.evidence, messageId: sent.messageId }
      existing = 2
    }
    const result = await f.engine.accept(envelope)
    await f.engine.drive()
    const executes = mode === 'auto' || kind === 'manual'
    expect(result.status).toBe(mode === 'off' && kind !== 'manual' ? 'rejected' : 'accepted')
    expect(await f.ctx.sessionPersistence.list()).toHaveLength(existing + (executes && kind !== 'handoff-timeout' ? 1 : 0))
    if (executes && kind !== 'handoff-timeout') await f.settle()
    if (executes && kind === 'handoff-timeout') {
      expect((await f.engine.pending({ limit: 10 })).items).toHaveLength(0)
      expect((await f.effects()).filter(effect => effect.kind === 'open/intent')).toHaveLength(0)
    }
  }, 20000)

it('A08 authenticates real HTTP bytes and durably deduplicates three signed deliveries', async () => {
  const f = await setup()
  await f.save(f.definition())
  expect(f.port).toBeGreaterThan(0)
  expect(await f.webhook(false, 'event-http')).toMatchObject({ status: 401, body: { code: 'source-authentication-failed' } })
  expect((await f.engine.pending({ limit: 10 })).items).toHaveLength(0)
  expect(await f.ctx.sessionPersistence.list()).toHaveLength(0)
  expect((await f.effects()).filter(item => item.kind === 'source/rejected')).toHaveLength(1)
  expect(await f.webhook(true, 'event-http')).toMatchObject({ status: 202, body: { status: 'accepted' } })
  for (let index = 0; index < 2; index++) expect(await f.webhook(true, 'event-http'))
    .toMatchObject({ status: 202, body: { status: 'duplicate' } })
  expect((await f.engine.pending({ limit: 10 })).items).toHaveLength(1)
}, 20000)

it('A10 emits created callbacks before the held model finishes and retries the same identity', async () => {
  const f = await setup()
  const def = f.definition()
  await f.save(def)
  f.model.hold()
  f.failCallbacks(1)
  await f.engine.setProjectMode({ projectId: def.projectId, mode: 'auto', expectedRevision: 0, operationId: operation() })
  await f.engine.accept({ ...f.trigger(), taskId: 'task-a' as never })
  await f.engine.drive()
  expect(f.callbacks).toHaveLength(1)
  const first = f.callbacks[0]!
  expect(first).toMatchObject({ kind: 'opened', taskId: 'task-a', seat: 'seat-a' })
  if (first.kind !== 'opened') throw new Error(JSON.stringify(first))
  expect(await f.ctx.sessionPersistence.stat(first.sessionId)).toBeDefined()
  expect(f.ctx.agents.get(first.sessionId)?.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind !== 'error')).toBe(false)
  await expect.poll(async () => { await f.engine.drive(); return f.callbacks.length }).toBe(2)
  expect(f.callbacks[1]).toEqual(first)
  f.model.finish()
  await f.settle()
}, 20000)

it('A11 defaults to remind, prevents rule widening and preserves paused work', async () => {
  const f = await setup()
  const def = f.definition('seat-a', { rules: [{ id: 'rule-a' as never, enabled: true,
    trigger: { kind: 'external', sourceId: f.sourceId }, mode: 'auto', timeWindows: [], exclusiveTags: [] }] })
  await f.save(def)
  expect(await f.engine.projectPolicy(def.projectId)).toEqual({ projectId: def.projectId, mode: 'remind', modeChosen: false, revision: 0 })
  await f.engine.accept(f.trigger())
  await f.engine.drive()
  expect(await f.ctx.sessionPersistence.list()).toHaveLength(0)
  const pending = (await f.engine.pending({ limit: 10 })).items[0]!
  expect(pending.reason).toBe('approval')
  expect((await f.engine.query({ kinds: ['queue/reminded'], limit: 10 })).effects).toHaveLength(1)
  expect(await f.engine.approve({ queueItemId: pending.queueItemId, expectedStateVersion: pending.stateVersion,
    operationId: operation() })).toMatchObject({ status: 'approved' })
  await f.engine.setProjectMode({ projectId: def.projectId, mode: 'off', expectedRevision: 0, operationId: operation() })
  await f.engine.drive()
  expect(await f.ctx.sessionPersistence.list()).toHaveLength(0)
  expect((await f.engine.pending({ limit: 10 })).items).toMatchObject([{ queueItemId: pending.queueItemId, reason: 'project-off' }])
  await f.engine.setProjectMode({ projectId: def.projectId, mode: 'auto', expectedRevision: 1, operationId: operation() })
  await f.engine.drive()
  expect(await f.ctx.sessionPersistence.list()).toHaveLength(1)
  await f.settle()
}, 20000)

it('A14 rejects wildcard batches before side effects and opens only three explicit seats', async () => {
  const f = await setup()
  for (const name of ['seat-a', 'seat-b', 'seat-c', 'seat-d']) await f.save(f.definition(name))
  for (const name of ['all', '*', String.fromCodePoint(0x5168, 0x90e8)]) {
    expect(await f.seats.openBatch({ seats: [seatName(name)], origin: 'manual', operationId: operation() }))
      .toMatchObject({ status: 'rejected' })
    expect(await f.ctx.sessionPersistence.list()).toHaveLength(0)
  }
  const result = await f.seats.openBatch({ seats: ['seat-a', 'seat-b', 'seat-c'].map(seatName), origin: 'manual', operationId: operation() })
  expect(result).toMatchObject({ status: 'processed', results: [
    { seat: 'seat-a', result: { status: 'opened' } }, { seat: 'seat-b', result: { status: 'opened' } }, { seat: 'seat-c', result: { status: 'opened' } },
  ] })
  expect(await f.ctx.sessionPersistence.list()).toHaveLength(3)
  expect(await f.seats.list({})).toMatchObject({ unopenedSeats: ['seat-d'] })
}, 20000)

it('A12 reports idle and running windows alongside unopened seats and rejects busy renewal', async () => {
  const f = await setup()
  await f.save(f.definition())
  await f.save(f.definition('seat-b'))
  const opened = await f.open()
  await f.settle()
  expect(await f.seats.list({})).toMatchObject({ sessions: [{ sessionId: opened.sessionId, status: 'completed' }], unopenedSeats: ['seat-b'] })
  const prefilled = await f.seats.open({ seat: seatName('seat-b'), origin: 'manual', openingMode: 'prefill', operationId: operation() })
  expect(prefilled, JSON.stringify(prefilled)).toMatchObject({ status: 'prefilled' })
  if (prefilled.status !== 'prefilled') throw new Error(JSON.stringify(prefilled))
  await f.settle()
  const settled = await f.seats.list({})
  if (settled.status !== 'listed') throw new Error(JSON.stringify(settled))
  expect(settled.sessions.find(item => item.sessionId === opened.sessionId)).toMatchObject({ status: 'completed' })
  expect(settled.sessions.find(item => item.sessionId === prefilled.sessionId)).toMatchObject({ status: 'idle' })
  expect(settled.unopenedSeats).toEqual([])
  f.model.hold()
  await f.seats.wake({ seat: seatName('seat-a'), sessionId: opened.sessionId, operationId: operation() })
  await expect.poll(async () => {
    const listing = await f.seats.list({})
    return listing.status === 'listed' && listing.sessions.find(item => item.sessionId === opened.sessionId)?.status
  }).toBe('running')
  const running = await f.seats.list({})
  if (running.status !== 'listed') throw new Error(JSON.stringify(running))
  expect(running.sessions.find(item => item.sessionId === opened.sessionId)).toMatchObject({ status: 'running', canRenew: false })
  expect(await f.seats.renew({ sessionId: opened.sessionId, operationId: operation() })).toMatchObject({ status: 'rejected' })
}, 20000)

it('A13 refuses busy close and archives idle windows before persisting the closed title', async () => {
  const f = await setup()
  await f.save(f.definition())
  const opened = await f.open()
  await f.settle()
  f.model.hold()
  await f.seats.wake({ seat: seatName('seat-a'), sessionId: opened.sessionId, operationId: operation() })
  await expect.poll(() => f.model.requests.length).toBe(2)
  const listing = await f.seats.list({})
  if (listing.status !== 'listed') throw new Error(JSON.stringify(listing))
  expect(await f.seats.close({ sessionId: opened.sessionId,
    expectedStateVersion: listing.sessions[0]!.stateVersion, operationId: operation() }))
    .toMatchObject({ status: 'busy' })
  f.model.finish()
  await f.settle()
  const idle = await f.seats.list({})
  if (idle.status !== 'listed') throw new Error(JSON.stringify(idle))
  expect(await f.seats.close({ sessionId: opened.sessionId,
    expectedStateVersion: idle.sessions[0]!.stateVersion, operationId: operation() }))
    .toMatchObject({ status: 'closed' })
  const closed = await f.ctx.sessionQuery.readSession(opened.sessionId)
  expect(JSON.stringify(closed)).toContain(String.fromCodePoint(0x5173, 0x7a97))
}, 20000)

it('A15 returns a fifth durable child ticket without blocking and preserves admission order', async () => {
  const f = await setup()
  await f.save(f.definition())
  const opened = await f.open()
  const tickets: ChildAdmissionTicket[] = []
  for (let index = 0; index < 5; index++) {
    const ticket: ChildAdmissionTicket = { ticketId: `ticket-${index}` as never, parentSessionId: opened.sessionId,
      sequence: 0, requestDigest: 'digest-a' as never, agentPreset: 'agent-a', permissionRevision: 1,
      phase: 'queued', childSessionId: null, ownerEpoch: 'epoch-a' as never, stateVersion: 0 }
    tickets.push(ticket)
    const result = await measured(`A15 ticket ${index}`, () => f.engine.admitChild({ ticket, maxActive: 4 }))
    expect(result.value.status).toBe(index < 4 ? 'admitted' : 'queued')
    expect(result.milliseconds).toBeLessThan(5000)
  }
  await f.engine.releaseChild(tickets[0]!.ticketId)
  expect(await f.engine.ticket(tickets[4]!.ticketId)).toMatchObject({ phase: 'admitted' })
}, 20000)

it('A15 queues outside a cross-midnight window and keeps FIFO waiters free of resources at capacity', async () => {
  const time = clock()
  try {
    const next = new Date(Date.now()); next.setUTCHours(22, 59, 0, 0)
    time.advance(next.getTime() - Date.now())
    const f = await setup({ engine: { nodeEngineWindowLimit: 1 } })
    for (const name of ['seat-a', 'seat-b', 'seat-c']) await f.save(f.definition(name, { rules: [{ id: 'rule-a' as never,
      enabled: true, trigger: { kind: 'external', sourceId: f.sourceId }, exclusiveTags: ['exclusive-a'],
      timeWindows: [{ timeZone: 'UTC', start: '23:00', end: '01:00', weekdays: [next.getUTCDay()] }] }] }))
    await f.engine.setProjectMode({ projectId: f.definition().projectId, mode: 'auto', expectedRevision: 0, operationId: operation() })
    for (const name of ['seat-a', 'seat-b', 'seat-c']) await f.engine.accept(f.trigger('external', name, name))
    await f.engine.drive()
    expect(await f.ctx.sessionPersistence.list()).toHaveLength(0)
    expect((await f.effects()).filter(item => item.kind === 'resource/reserved')).toHaveLength(0)
    time.advance(60000)
    await f.engine.drive()
    expect(await f.ctx.sessionPersistence.list()).toHaveLength(1)
    expect((await f.engine.pending({ limit: 10 })).items.map(item => item.seat)).toEqual(['seat-b', 'seat-c'])
    expect((await f.effects()).filter(item => item.kind === 'resource/reserved').map(item => item.data.seat)).toEqual(['seat-a'])
  } finally { time.close() }
}, 20000)

it('A17 accounts durable costs and defers only new turns after the full budget is spent', async () => {
  const f = await setup({ onBase: async (ctx) => {
    const price: import('@panedesk/dsh-session-ledger').LedgerPriceEntry = {
      version: 'test-v1', sourceUrls: ['https://example.invalid/test-prices'], retrievedOn: '2026-01-01', reference: true,
      modelFamily: 'model-a', modelKey: 'model-a', currency: 'USD', holidaysUnmodeled: true,
      prices: { input: '0.1', cacheRead: '0.1', cacheWrite: { '5m': '0.1', '1h': '0.1' }, output: '0.2' },
    }
    const resolve = ctx.sessionLedger.resolveCallContext.bind(ctx.sessionLedger)
    ctx.sessionLedger.resolveCallContext = async (request) => {
      const resolved = await resolve(request)
      return { ...resolved, price, priceTable: { ...price, entries: [price] } }
    }
  } })
  const stream = f.model.stream.bind(f.model)
  f.model.stream = async function* (options) {
    for await (const chunk of stream(options)) {
      yield chunk.type === 'usage' ? { ...chunk, usage: { ...chunk.usage, cacheWriteLongTokens: 0 } } : chunk
    }
  }
  await f.save(f.definition())
  const opened = await f.open()
  await f.settle()
  expect(f.model.requests).toHaveLength(1)
  expect(await f.engine.configureBudget({ sessionId: opened.sessionId, limits: { windowBudgetUsd: '100' as never }, expectedRevision: 0,
    authorizationRef: 'owner' as never, operationId: operation() })).toMatchObject({ status: 'configured' })
  await recordCost(f.ctx, opened.sessionId, 'cost-a', '0.00008')
  await f.settle()
  await expect.poll(async () => {
    const ledger = await f.ctx.sessionLedger.snapshot({ sessionId: opened.sessionId })
    const calls = ledger.rows.filter(row => row.kind === 'call')
    return ledger.complete && calls.length === 3 && calls.every(row => row.finish?.costUsd !== undefined)
  }).toBe(true)
  expect(f.model.requests).toHaveLength(2)
  const calls = (await f.ctx.sessionLedger.snapshot({ sessionId: opened.sessionId })).rows.filter(row => row.kind === 'call')
  expect(calls.filter(row => row.start.callId !== 'cost-a').map(row => row.finish)).toEqual([
    expect.objectContaining({ pricingState: 'priced', priceVersion: 'test-v1', costUsd: '0.000004' }),
    expect.objectContaining({ pricingState: 'priced', priceVersion: 'test-v1', costUsd: '0.000004' }),
  ])
  // Opening and warning each cost 10 * 0.1 + 20 * 0.1 + 5 * 0.2 = 4 micro-USD; 80 + 2 * 4 = 88.
  expect(await f.engine.budget(opened.sessionId)).toMatchObject({ windowCost: '88' })
  expect((await f.effects()).filter(effect => effect.kind === 'budget/warning')).toHaveLength(1)
  await f.engine.drive()
  expect((await f.effects()).filter(effect => effect.kind === 'budget/warning')).toHaveLength(1)
  await recordCost(f.ctx, opened.sessionId, 'cost-b', '0.00002')
  expect(await f.engine.admitTurn(opened.sessionId)).toMatchObject({ status: 'defer', reason: 'budget-stopped' })
  const wake = await f.seats.wake({ seat: seatName('seat-a'), sessionId: opened.sessionId, operationId: operation() })
  expect(wake).toMatchObject({ status: 'stored-budget-stopped' })
  if (wake.status !== 'stored-budget-stopped') throw new Error(JSON.stringify(wake))
  expect(await f.ctx.messageDelivery.status(wake.messageId)).toMatchObject({ state: 'queued' })
}, 20000)

it('A18 preserves the latest three self-report fields and revokes a close candidate by version', async () => {
  const f = await setup()
  await f.save(f.definition())
  const opened = await f.open()
  const report = { reportId: 'report-a' as never, sessionId: opened.sessionId, canClose: false,
    waitingFor: [{ kind: 'other' as const, summary: 'External review.' }],
    nextOpen: { when: { kind: 'unspecified' as const }, prerequisites: ['Review complete.'] },
    submittedAt: new Date().toISOString(), stateVersion: 1 }
  const recorded = await f.seats.submitReport({ report, operationId: operation() })
  expect(recorded).toMatchObject({ status: 'recorded' })
  if (recorded.status !== 'recorded') throw new Error(JSON.stringify(recorded))
  expect(await f.seats.revokeReport({ reportId: report.reportId, sessionId: opened.sessionId,
    expectedStateVersion: recorded.stateVersion, operationId: operation() })).toMatchObject({ status: 'revoked' })
  expect(await f.ctx.sessionPersistence.stat(opened.sessionId)).toBeDefined()
  expect(JSON.stringify(await f.effects())).toContain('Review complete.')
}, 20000)

it('A19 wakes an all-object schedule wait once within five seconds without polling tools', async () => {
  const f = await setup()
  await f.save(f.definition())
  const { sessionId } = await f.open()
  const request = { title: 'Review', prompt: 'Review pending work.', every_seconds: 3600 }
  const first = await f.ctx.schedule.create(sessionId, request)
  const second = await f.ctx.schedule.create(sessionId, request)
  const wait = { sessionId, waitId: 'wait-a' as never, mode: 'all' as const,
    objects: [{ kind: 'schedule' as const, id: first.id }, { kind: 'schedule' as const, id: second.id }], operationId: operation() }
  expect(await f.seats.registerWait(wait)).toMatchObject({ status: 'registered' })
  await f.ctx.schedule.delete({ sessionId, id: first.id })
  await expect.poll(async () => (await f.seats.wait(wait.waitId))?.observations.length).toBe(1)
  expect((await f.seats.wait(wait.waitId))?.phase).toBe('registered')
  const result = await measured('A19 schedule wake', async () => {
    await f.ctx.schedule.delete({ sessionId, id: second.id })
    await expect.poll(async () => (await f.seats.wait(wait.waitId))?.phase, { timeout: 5000 }).toBe('woken')
  })
  expect(result.milliseconds).toBeLessThan(5000)
  const replay = await f.seats.registerWait(wait)
  expect(replay, JSON.stringify(replay)).toMatchObject({ status: 'registered', wait: { phase: 'woken' } })
  await f.settle()
  expect(f.model.requests.filter(item => JSON.stringify(item).includes('Wait wait-a'))).toHaveLength(1)
}, 20000)

it('A20 denies the third polling call and a literal nine-hundred-second sleep', async () => {
  const f = await setup()
  const base = { operationId: operation(), nodeId: f.nodeId, seat: null, sessionId: null,
    observedAt: new Date().toISOString(), hook: 'before-tool-call' as const, toolName: 'bash',
    arguments: { command: 'sleep 1' }, hasPendingWork: true, cwd: join(f.home, 'workspace-a') }
  for (let index = 1; index <= 3; index++) {
    const result = await f.ctx.seatGates.evaluate({ ...base, callId: `poll-${index}` as never })
    expect(result.some(item => item.outcome === 'deny')).toBe(index === 3)
    if (index === 3) expect(result.filter(item => item.outcome === 'deny').map(item => item.reason.code)).toContain('polling')
  }
  const long = await f.ctx.seatGates.evaluate({ ...base, callId: 'sleep-long' as never, arguments: { command: 'sleep 900' } })
  expect(long.filter(item => item.outcome === 'deny').map(item => item.reason.code)).toContain('sleep-limit-exceeded')
}, 20000)

it('A20 refuses expired continuation through the real manager while permitting a fresh child', async () => {
  const time = clock()
  try {
    const f = await setup()
    await f.save(f.definition())
    const opened = await f.open()
    const parent = f.ctx.agents.get(opened.sessionId)!
    await parent.whenIdle()
    const request = { parent, prompt: [{ type: 'text' as const, text: 'Neutral child task.' }] }
    const first = await f.ctx.subagents.startActivation({ provider: 'spawn', label: 'child-a', request,
      signal: new AbortController().signal, delivery: 'caller' })
    try {
      await f.settle()
      await first.result
      time.advance(61 * 60000)
      const resumed = await f.ctx.subagents.sendMessage(parent, first.childId, [{ type: 'text', text: 'Continue.' }],
        { signal: new AbortController().signal }).then(() => 'accepted', (error: unknown) => error instanceof Error ? error.message : String(error))
      expect(resumed).not.toBe('accepted')
      expect(resumed).toContain('cache')
      const fresh = await f.ctx.subagents.startActivation({ provider: 'spawn', label: 'child-b', request,
        signal: new AbortController().signal, delivery: 'caller' })
      try { expect(fresh.childId).not.toBe(first.childId); await fresh.result } finally { await fresh.dispose() }
    } finally { await first.dispose() }
  } finally { time.close() }
}, 20000)

it('A21 persists three custom gate hits and one expiry without retaining denial after expiry', async () => {
  const time = clock()
  try {
    const definition: GateDefinition = { id: 'custom-a' as never, name: 'Explicit path', hook: 'before-tool-call',
      criterion: { type: 'custom-a' as never, parameters: {} }, alternative: 'Use an explicit path.',
      expiresAt: new Date(Date.now() + 60000).toISOString(), enabled: true, revision: 1, order: 0 }
    const f = await setup({ gates: [definition] })
    const dispose = f.ctx.seatGates.register({ id: definition.criterion.type, async evaluate(_context, row) {
      return { outcome: 'deny', gateId: row.id, revision: row.revision, expiresAt: row.expiresAt, hitCount: 0,
        audit: 'recorded', alternative: row.alternative, reason: { code: 'gate-denied', message: 'An explicit path is required.',
          alternative: row.alternative, retryable: false, effectState: 'none' } }
    } })
    try {
      const base = { operationId: operation(), nodeId: f.nodeId, seat: null, sessionId: null,
        hook: 'before-tool-call' as const, toolName: 'neutral-tool', arguments: {}, hasPendingWork: false }
      for (let index = 1; index <= 3; index++) expect(await f.ctx.seatGates.evaluate({ ...base,
        observedAt: new Date().toISOString(), callId: `custom-${index}` as never }))
        .toContainEqual(expect.objectContaining({ gateId: definition.id, outcome: 'deny', hitCount: index }))
      time.advance(60000)
      for (const callId of ['expired-a', 'expired-b']) expect(await f.ctx.seatGates.evaluate({ ...base,
        observedAt: new Date().toISOString(), callId: callId as never }))
        .toContainEqual(expect.objectContaining({ gateId: definition.id, outcome: 'allow', hitCount: 3 }))
      const facts = await f.effects()
      expect(facts.filter(item => item.kind === 'gate/hit' && item.data.definition.id === definition.id)).toHaveLength(3)
      expect(facts.filter(item => item.kind === 'gate/expired' && item.data.definition.id === definition.id)).toHaveLength(1)
    } finally { dispose() }
  } finally { time.close() }
}, 20000)

it('A23 rejects cross-node opening before Session creation and records the rejection locally', async () => {
  const f = await setup({ engine: { nodeEngineWindowLimit: 1 }, aliases: { 'node-b': 'foreign-node' as never } })
  await f.save(f.definition())
  const revision = (await f.seats.definitions({})).revision
  expect(await f.seats.save({ definition: f.definition('seat-b', { node: 'node-b' }), expectedRevision: revision, operationId: operation() }))
    .toMatchObject({ status: 'rejected', error: { code: 'cross-node-unsupported' } })
  expect(await f.seats.open({ seat: seatName('seat-a'), origin: 'manual', nodeId: 'foreign-node' as never, operationId: operation() }))
    .toMatchObject({ status: 'rejected', error: { code: 'cross-node-unsupported' } })
  expect(await f.ctx.sessionPersistence.list()).toHaveLength(0)
  expect(await f.engine.nodeStatus()).toMatchObject({ openEngineWindows: 0, limit: 1 })
  expect((await f.effects()).filter(item => item.kind === 'open/rejected').map(item => item.data.error.code))
    .toContain('cross-node-unsupported')
}, 20000)

it('A16 releases a killed host owner and admits its exclusive waiter within five seconds of ready', async () => {
  const home = await mkdtemp(join(process.cwd(), '.acceptance-owner-'))
  const children: ReturnType<typeof childFixture>[] = []
  try {
    const owner = childFixture(home, 'owner-held'); children.push(owner)
    await owner.ready
    await owner.stop()
    expect(await owner.exited).toEqual([null, 'SIGKILL'])
    const recovered = childFixture(home, 'owner-recover'); children.push(recovered)
    await recovered.ready
    const result = JSON.parse(await readFile(join(home, 'owner-recovery.json'), 'utf8')) as { effects: EngineEffect[]; milliseconds: number }
    console.log(JSON.stringify({ name: 'A16 ready to release', milliseconds: result.milliseconds }))
    expect.soft(result.effects.filter(effect => effect.kind === 'resource/released').map(effect => effect.data))
      .toContainEqual(expect.objectContaining({ reason: 'host-restart-recovery', fenced: true }))
    expect.soft(openingFacts(result.effects)).toHaveLength(2)
    expect(result.milliseconds).toBeLessThanOrEqual(5000)
  } finally {
    for (const child of children) await child.stop()
    await rm(home, { recursive: true, force: true })
  }
}, 30000)

it('A22 compacts real history and reinjects required checkpoint content before durable publication', async () => {
  const f = await setup()
  const path = join(f.home, 'memory-a', 'checkpoint.md')
  await writeFile(path, '# Checkpoint\nRequired checkpoint fact.\n')
  await f.save(f.definition('seat-a', { opening: { kind: 'text', text: 'Neutral history. '.repeat(300) },
    checkpointFiles: [{ path, section: 'Checkpoint', maxBytes: 1024, required: true }] }))
  const opened = await f.open()
  await f.settle()
  const agent = f.ctx.agents.get(opened.sessionId)!
  const before = agent.session.snapshotEvents()
  expect(await f.ctx.compaction.compactNow(agent, new AbortController().signal)).not.toBeNull()
  await f.ctx.sessions.flush(agent.session)
  const after = await f.ctx.sessionQuery.readSession(agent.id)
  expect(JSON.stringify(after)).toContain('Required checkpoint fact.')
  expect(after?.events.filter(event => event.type === 'compaction/summary')).toHaveLength(1)
  expect(agent.session.snapshotEvents().length).toBeGreaterThan(before.length)
  expect((await f.ctx.sessionLedger.query({ sessionId: agent.id })).rows.some(row => row.kind === 'call' && row.start.purpose === 'compaction')).toBe(true)
}, 20000)

it('A24 paginates an independent engine namespace and verifies redacted JSONL without changing Session history', async () => {
  const f = await setup()
  await f.save(f.definition())
  const opened = await f.open()
  await f.ctx.agents.get(opened.sessionId)!.whenIdle()
  await f.engine.shutdown()
  const before = await f.ctx.sessionQuery.readSession(opened.sessionId)
  const all = await f.effects()
  const collected: EngineEffect[] = []
  let cursor: import('@panedesk/dsh-seat').EngineCursor | undefined
  for (let pageIndex = 0; pageIndex < 1000; pageIndex++) {
    const page = await f.engine.query({ limit: 1, ...(cursor ? { cursor } : {}) })
    collected.push(...page.effects)
    if (page.complete) break
    expect(page.nextCursor).toBeDefined()
    cursor = page.nextCursor
  }
  expect(collected).toEqual(all)
  const output = join(f.home, 'engine-export.jsonl')
  expect(await f.engine.export({ query: { limit: 10000 }, format: 'jsonl', output })).toMatchObject({ status: 'exported' })
  expect(await f.engine.verify({ input: output })).toMatchObject({ status: 'verified', tail: 'complete' })
  const frames = (await readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { namespace: string })
  expect(frames.every(frame => frame.namespace === 'ledger/engine/v1')).toBe(true)
  expect(await f.ctx.sessionQuery.readSession(opened.sessionId)).toEqual(before)
}, 20000)

it('A24 keeps legacy readers stable beside an engine namespace and rejects a misfiled engine frame', async () => {
  const f = await setup()
  const recipient = await f.ctx.sessionCreation.create({ sessionId: 'legacy-reader' as never, cwd: join(f.home, 'workspace-b') })
  await f.ctx.messageDelivery.send({ target: { sessionId: recipient.agent.id }, operationId: operation() as never,
    messageClass: 'handoff', priority: 'queue', content: 'Legacy message.' })
  await expect.poll(async () => (await f.ctx.sessionLedger.queryMessages({ targetSessionId: recipient.agent.id })).items
    .some(item => item.state === 'responded'), { timeout: 5000 }).toBe(true)
  await expect.poll(async () => (await f.ctx.sessionLedger.query({ sessionId: recipient.agent.id })).rows
    .some(row => row.kind === 'call' && row.finish !== undefined), { timeout: 5000 }).toBe(true)
  const callsBefore = await f.ctx.sessionLedger.query({ sessionId: recipient.agent.id })
  const ledgerIdentity = (page: { items: readonly { messageId: string; data: { messageClass: string } }[] }) =>
    page.items.map(item => [item.messageId, item.data.messageClass])
  const listedIdentity = (page: { items: readonly { messageId: string; transitions: readonly { data: { messageClass: string } }[] }[] }) =>
    page.items.map(item => [item.messageId, item.transitions.at(-1)?.data.messageClass])
  const messagesBefore = ledgerIdentity(await f.ctx.sessionLedger.queryMessages({ targetSessionId: recipient.agent.id }))
  const listedBefore = listedIdentity(await f.ctx.messageDelivery.list({ targetSessionId: recipient.agent.id }))
  expect(messagesBefore).toEqual([[expect.any(String), 'handoff']])
  expect(listedBefore).toEqual(messagesBefore)
  await f.save(f.definition())
  const opened = await f.open()
  await f.settle()
  const engineFrames = (await f.engine.query({ limit: 10000 })).effects
  expect(engineFrames.length).toBeGreaterThan(0)
  const callsAfter = await f.ctx.sessionLedger.query({ sessionId: recipient.agent.id })
  expect(callsAfter.rows).toEqual(callsBefore.rows)
  expect(callsAfter.complete).toBe(true)
  expect(Object.keys(callsAfter.watermarks)).toEqual(Object.keys(callsBefore.watermarks))
  const messagesAfter = await f.ctx.sessionLedger.queryMessages({ targetSessionId: recipient.agent.id })
  expect(ledgerIdentity(messagesAfter)).toEqual(messagesBefore)
  expect(listedIdentity(await f.ctx.messageDelivery.list({ targetSessionId: recipient.agent.id }))).toEqual(listedBefore)
  expect(JSON.stringify(messagesAfter).includes('ledger/engine/v1')).toBe(false)
  const session = await f.ctx.sessionQuery.readSession(opened.sessionId)
  expect(session?.events.some(event => event.type === 'user/message')).toBe(true)
  expect(session?.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed')).toBe(true)
  const nodeId = await f.ctx.sessionLedger.nodeId()
  const planted = join(f.home, 'ledger', 'v1', nodeId, 'events', '2099-01-01')
  await mkdir(planted, { recursive: true })
  await writeFile(join(planted, 'engine-frame.jsonl'), JSON.stringify({ schemaVersion: 1, eventId: 'engine-frame',
    nodeId, runId: 'run-a', sessionId: recipient.agent.id, kind: 'open/created', observedAt: Date.now() }) + '\n')
  const rejected = await f.ctx.sessionLedger.query({ sessionId: recipient.agent.id })
  expect(rejected.complete).toBe(false)
  expect(rejected.rows).toEqual(callsBefore.rows)
}, 20000)

it('A15 queues the real fifth child immediately and starts it after a capacity release', async () => {
  const f = await setup()
  await f.save(f.definition())
  const opened = await f.open()
  await f.settle()
  const parent = f.ctx.agents.get(opened.sessionId)!
  f.model.hold()
  const activations: import('@panedesk/dsh-subagent').SubagentActivation[] = []
  try {
    for (let index = 0; index < 4; index++) activations.push(await f.ctx.subagents.startActivation({ provider: 'spawn',
      label: `child-${index}`, request: { parent, maxDepth: 8, prompt: [{ type: 'text', text: `Task ${index}.` }] },
      signal: new AbortController().signal, delivery: 'caller' }))
    const fifth = await measured('A15 real fifth child', () => f.ctx.subagents.requestActivation({ provider: 'spawn',
      label: 'child-4', request: { parent, maxDepth: 8, prompt: [{ type: 'text', text: 'Task 4.' }] },
      signal: new AbortController().signal, delivery: 'caller' }))
    expect(fifth.milliseconds).toBeLessThan(5000)
    expect(fifth.value).toMatchObject({ status: 'queued', parentSessionId: parent.id })
    if (!('status' in fifth.value)) { activations.push(fifth.value); throw new Error('The fifth child bypassed admission') }
    const ticket = fifth.value.ticketId
    expect(await f.engine.ticket(ticket)).toMatchObject({ phase: 'queued', childSessionId: null })
    expect(f.ctx.agents.list()).toHaveLength(5)
    f.model.finish()
    await Promise.all(activations.map(child => child.result))
    await expect.poll(async () => (await f.engine.ticket(ticket))?.phase, { timeout: 5000 }).toBe('released')
    expect(f.model.requests.some(request => JSON.stringify(request).includes('Task 4.'))).toBe(true)
  } finally { f.model.finish(); for (const child of activations) await child.dispose() }
}, 30000)

it('A15 preserves an eight-level real parent chain and rejects the ninth child', async () => {
  const f = await setup()
  await f.save(f.definition())
  const opened = await f.open()
  await f.settle()
  let parent = f.ctx.agents.get(opened.sessionId)!
  const activations: import('@panedesk/dsh-subagent').SubagentActivation[] = []
  const { delegationDepthOf } = await import('@panedesk/dsh-subagent')
  f.model.hold()
  try {
    for (let depth = 1; depth <= 8; depth++) {
      const child = await f.ctx.subagents.startActivation({ provider: 'spawn', label: `level-${depth}`,
        request: { parent, maxDepth: 8, prompt: [{ type: 'text', text: 'Neutral nested task.' }] },
        signal: new AbortController().signal, delivery: 'caller' })
      activations.push(child)
      const descendant = f.ctx.agents.get(child.childId)!
      expect(descendant.session.header.parentSession).toBe(parent.id)
      expect(delegationDepthOf(descendant)).toBe(depth)
      parent = descendant
    }
    const before = (await f.ctx.sessionPersistence.list()).length
    await expect(f.ctx.subagents.startActivation({ provider: 'spawn', label: 'level-9', request: { parent, maxDepth: 8,
      prompt: [{ type: 'text', text: 'Must not start.' }] }, signal: new AbortController().signal, delivery: 'caller' })).rejects.toThrow(/depth/i)
    expect(await f.ctx.sessionPersistence.list()).toHaveLength(before)
  } finally { f.model.finish(); for (const child of activations.reverse()) { await child.result; await child.dispose() } }
}, 30000)

it.each(['authorized-idle', 'not-authorized', 'running', 'child', 'job'] as const)(
  'A18 requires all three automatic close conditions for %s', async (scenario) => {
    const f = await setup()
    await f.save(f.definition())
    const opened = await f.open()
    await f.settle()
    const parent = f.ctx.agents.get(opened.sessionId)!
    let child: import('@panedesk/dsh-subagent').SubagentActivation | undefined
    if (scenario === 'running' || scenario === 'child') {
      f.model.hold()
      if (scenario === 'running') await f.seats.wake({ seat: seatName('seat-a'), sessionId: parent.id, operationId: operation() })
      else child = await f.ctx.subagents.startActivation({ provider: 'spawn', label: 'held-child', request: { parent,
        prompt: [{ type: 'text', text: 'Pending child work.' }] }, signal: new AbortController().signal, delivery: 'caller' })
      await expect.poll(() => f.model.requests.length).toBe(2)
    }
    let finishJob: (() => void) | undefined
    let detachJobs: (() => void) | undefined
    if (scenario === 'job') {
      detachJobs = f.ctx.jobs.attachController('acceptance-jobs')
      const done = new Promise<{ status: 'completed' }>((resolve) => { finishJob = () => { resolve({ status: 'completed' }) } })
      f.ctx.jobs.start({ kind: 'bash', label: 'Pending work.', owner: parent.id,
        run: () => ({ done, cancel: () => { finishJob?.() } }) })
    }
    const messagesBefore = await f.ctx.sessionLedger.queryMessages({ sessionId: parent.id, limit: 100 })
    try {
      expect(await f.seats.submitReport({ report: { reportId: 'automatic-a' as never, sessionId: parent.id,
        canClose: scenario !== 'not-authorized', waitingFor: [], nextOpen: { when: { kind: 'unspecified' }, prerequisites: [] },
        submittedAt: new Date().toISOString(), stateVersion: 1 }, operationId: operation() })).toMatchObject({ status: 'recorded' })
      expect(f.ctx.workspaceRegistry.archivedSessionIds.includes(parent.id)).toBe(scenario === 'authorized-idle')
      if (scenario === 'running' || scenario === 'child' || scenario === 'job') {
        const facts = await f.effects()
        expect(facts.filter(effect => effect.kind === 'window/closed')).toHaveLength(0)
        await expect.poll(async () => (await f.ctx.sessionLedger.queryMessages({ sessionId: parent.id, limit: 100 })).items.length,
          { timeout: 5000 }).toBe(messagesBefore.items.length + 1)
        const reminder = (await f.ctx.sessionLedger.queryMessages({ sessionId: parent.id, limit: 100 })).items.at(-1)
        expect(reminder?.data).toMatchObject({ messageClass: 'handoff', priority: 'steer' })
        const records = await readdir(join(f.home, 'messages'), { recursive: true })
        const bodies: string[] = []
        for (const name of records) {
          if (!name.endsWith('.json')) continue
          const envelope = JSON.parse(await readFile(join(f.home, 'messages', name), 'utf8')) as { payload?: string }
          const value = JSON.parse(envelope.payload ?? '{}') as { value?: { message?: { content?: string } }; message?: { content?: string } }
          const content = value.value?.message?.content ?? value.message?.content
          if (typeof content === 'string') bodies.push(content)
        }
        const delivered = bodies.filter(body => body.includes('This window still has pending work:'))
        expect(delivered.length, JSON.stringify(delivered)).toBeGreaterThan(0)
        console.log(JSON.stringify({ name: `A18 reminder ${scenario}`, copies: delivered.length }))
        const listed = await f.seats.list({})
        if (listed.status !== 'listed') throw new Error(JSON.stringify(listed))
        const reasons = listed.sessions.find(item => item.sessionId === parent.id)?.busyReasons ?? []
        expect(reasons.length).toBeGreaterThan(0)
        const summaries = reasons.map(reason => reason.summary)
        const cited = delivered[0]?.split(': ').slice(1).join(': ').split('; ') ?? []
        expect(cited.length, JSON.stringify(delivered)).toBeGreaterThan(0)
        expect(cited.every(summary => summaries.includes(summary)), JSON.stringify({ cited, summaries })).toBe(true)
        const beforeRepeat = (await f.ctx.sessionLedger.queryMessages({ sessionId: parent.id, limit: 100 })).items.length
        if (!(f.seats instanceof LocalSeatService)) throw new Error('seat service is not local')
        await f.seats.reevaluateReport(parent.id)
        const afterRepeat = (await f.ctx.sessionLedger.queryMessages({ sessionId: parent.id, limit: 100 })).items.length
        expect(afterRepeat, `reminder copies grew from ${beforeRepeat} to ${afterRepeat}`).toBe(beforeRepeat)
      }
    } finally {
      finishJob?.()
      detachJobs?.()
      f.model.finish()
      if (child) { await child.result; await child.dispose() }
    }
  }, 30000)

it('A14 applies CLI batch validation and the independent batch gate before any Session exists', async () => {
  const gate: GateDefinition = { id: 'batch-a' as never, name: 'Batch approval', hook: 'before-batch-open',
    criterion: { type: 'batch-a' as never, parameters: {} }, alternative: 'Approve this batch.',
    expiresAt: null, enabled: true, revision: 1, order: 0 }
  const f = await setup({ gates: [gate] })
  for (const name of ['seat-a', 'seat-b', 'seat-c']) await f.save(f.definition(name))
  const { executeSeatCommand } = await import('../src/cli.ts')
  for (const name of ['all', '*', String.fromCodePoint(0x5168, 0x90e8)]) {
    expect(await executeSeatCommand(f.ctx, ['open', '--seats', name])).toMatchObject({ code: 2 })
    expect(await f.ctx.sessionPersistence.list()).toHaveLength(0)
  }
  let approved = false
  let batches = 0
  const dispose = f.ctx.seatGates.register({ id: gate.criterion.type, async evaluate() {
    batches++
    return approved ? { outcome: 'allow', gateId: gate.id, revision: 1, expiresAt: null, hitCount: 0, audit: 'recorded' }
      : { outcome: 'deny', gateId: gate.id, revision: 1, expiresAt: null, hitCount: 0, audit: 'recorded',
        alternative: gate.alternative, reason: { code: 'gate-denied', message: 'Batch approval is required.',
          alternative: gate.alternative, retryable: false, effectState: 'none' } }
  } })
  try {
    expect(await executeSeatCommand(f.ctx, ['open', '--seats', 'seat-a,seat-b,seat-c'])).toMatchObject({ code: 2 })
    expect(batches).toBe(1)
    expect(await f.ctx.sessionPersistence.list()).toHaveLength(0)
    expect(f.model.requests).toHaveLength(0)
    approved = true
    expect(await executeSeatCommand(f.ctx, ['open', '--seats', 'seat-a,seat-b,seat-c', '--opening', 'auto'])).toMatchObject({ code: 0,
      output: { status: 'processed', results: ['seat-a', 'seat-b', 'seat-c'].map(seat => ({ seat, result: { status: 'opened' } })) } })
    expect(batches).toBe(2)
    expect(await f.ctx.sessionPersistence.list()).toHaveLength(3)
  } finally { dispose() }
}, 20000)

it.each(['register', 'task-ended', 'mature'] as const)('A21 enforces the %s worktree policy without deleting files', async (event) => {
  const f = await setup()
  const path = join(f.home, 'workspace-a', 'retained.txt')
  await writeFile(path, 'Retained work.')
  const decisions = await f.ctx.seatGates.evaluate({ callId: `tree-${event}` as never, operationId: operation(),
    nodeId: f.nodeId, seat: null, sessionId: null, observedAt: new Date().toISOString(),
    ...(event === 'register' ? { hook: 'before-open' as const, cwd: f.home, candidateSeats: [] }
      : { hook: 'before-tool-call' as const, toolName: 'worktree-observation', arguments: {}, hasPendingWork: false }),
    worktreeFacts: { event, clientTreeCount: 1, clientTreeLimit: 1, requestedKind: 'client', authorizedForce: false,
      alternative: 'Review the registered tree without deleting it.', mature: true } })
  const policy = event === 'register' ? 'worktree-client' : event === 'task-ended' ? 'worktree-settle' : 'worktree-mature'
  expect(decisions).toContainEqual(expect.objectContaining({ outcome: event === 'register' ? 'deny' : 'observe', hitCount: 1 }))
  expect(JSON.stringify(await f.effects())).toContain(policy)
  expect(await readFile(path, 'utf8')).toBe('Retained work.')
}, 20000)

it('A21 keeps a real worktree through registration, use and task settlement', async () => {
  const f = await setup()
  await f.save(f.definition())
  const root = join(f.home, 'repository')
  await mkdir(root, { recursive: true })
  const git = promisify(execFile)
  await git('git', ['init', '--initial-branch=main', root])
  const retained = join(root, 'retained.txt')
  await writeFile(retained, 'Retained work.')
  await git('git', ['-C', root, 'add', 'retained.txt'])
  await git('git', ['-C', root, '-c', 'user.email=seat@example.test', '-c', 'user.name=seat', 'commit', '-m', 'Retain work'])
  const { registerWorktree, taskEnded } = await import('../../seat-gates/src/worktree-service.ts')
  const registration = { repositoryId: join(root, '.git'), path: root, seat: seatName('seat-a'),
    taskId: 'task-a' as never, kind: 'client' as const, branch: 'main', registeredAt: new Date().toISOString() }
  const registered = await registerWorktree(f.ctx, { registration, operationId: operation() })
  expect(registered, JSON.stringify(registered)).toMatchObject({ status: 'registered' })
  expect(JSON.stringify(await f.effects())).not.toContain('worktree-client')
  const used = join(root, 'used.txt')
  await writeFile(used, 'Used work.')
  const extra = join(f.home, 'repository-b')
  await mkdir(extra, { recursive: true })
  await git('git', ['init', '--initial-branch=main', extra])
  const kept = join(extra, 'kept.txt')
  await writeFile(kept, 'Kept work.')
  await git('git', ['-C', extra, 'add', 'kept.txt'])
  await git('git', ['-C', extra, '-c', 'user.email=seat@example.test', '-c', 'user.name=seat', 'commit', '-m', 'Keep work'])
  const second = await registerWorktree(f.ctx, { registration: { ...registration, repositoryId: join(extra, '.git'),
    path: extra, taskId: 'task-b' as never }, operationId: operation() })
  expect(second, JSON.stringify(second)).toMatchObject({ status: 'rejected', error: { code: 'worktree-client-limit' } })
  expect(JSON.stringify(await f.effects())).toContain('worktree-client')
  const settled = await taskEnded(f.ctx, { taskId: registration.taskId, kind: 'settle', sourceId: f.sourceId,
    operationId: operation() })
  expect(settled, JSON.stringify(settled)).toMatchObject({ status: 'observed' })
  const facts = await f.effects()
  const encoded = JSON.stringify(facts)
  expect(encoded).toContain('worktree-settle')
  const mature = facts.filter(item => item.kind === 'gate/hit' && item.data.definition.id === 'worktree-mature')
  expect(mature).toHaveLength(0)
  expect(encoded).toContain('"event":"mature","mature":false')
  expect(await readFile(retained, 'utf8')).toBe('Retained work.')
  expect(await readFile(used, 'utf8')).toBe('Used work.')
  expect(await readFile(kept, 'utf8')).toBe('Kept work.')
}, 20000)

it('A23 reports a symbolic node name and rejects a foreign CLI target before side effects', async () => {
  const f = await setup({ aliases: { 'node-b': 'foreign-node' as never } })
  await f.save(f.definition())
  const { executeSeatCommand } = await import('../src/cli.ts')
  expect(await executeSeatCommand(f.ctx, ['nodeStatus'])).toMatchObject({ code: 0,
    output: { nodeName: 'node-a', nodeId: f.nodeId, openEngineWindows: 0 } })
  expect(await executeSeatCommand(f.ctx, ['open', '--seat', 'seat-a', '--node', 'foreign-node']))
    .toMatchObject({ code: 2, output: { error: { code: 'cross-node-unsupported' } } })
  expect(await f.ctx.sessionPersistence.list()).toHaveLength(0)
  expect(f.model.requests).toHaveLength(0)
  expect((await f.effects()).filter(effect => effect.kind === 'open/rejected')).toHaveLength(1)
}, 20000)

it('A24 filters seats, kinds, pending rows and gates while retaining legacy message pagination', async () => {
  const f = await setup()
  for (const name of ['seat-a', 'seat-b']) await f.save(f.definition(name))
  for (const name of ['seat-a', 'seat-b']) await f.engine.accept(f.trigger('external', name, name))
  await f.engine.drive()
  const pending = await f.engine.pending({ seat: seatName('seat-a'), limit: 1 })
  expect(pending.items).toHaveLength(1)
  expect(pending.items[0]?.seat).toBe('seat-a')
  const all = await f.effects()
  const selected = await f.engine.query({ seat: seatName('seat-a'), kinds: ['trigger/accepted'], limit: 100 })
  expect(selected.effects).toEqual(all.filter(effect => effect.seat === 'seat-a' && effect.kind === 'trigger/accepted'))
  expect(selected.effects).toHaveLength(1)
  const base = { operationId: operation(), nodeId: f.nodeId, seat: null, sessionId: null,
    observedAt: new Date().toISOString(), hook: 'before-tool-call' as const, toolName: 'bash',
    arguments: { command: 'sleep 900' }, hasPendingWork: false }
  await f.ctx.seatGates.evaluate({ ...base, callId: 'filter-gate' as never })
  const gates = await f.ctx.seatGates.list({ gateId: 'polling', limit: 1 })
  expect(gates.gates).toHaveLength(1)
  expect(gates.gates[0]?.hitCount).toBe(1)
  const recipient = await f.ctx.sessionCreation.create({ sessionId: 'legacy-recipient' as never, cwd: join(f.home, 'workspace-b') })
  const defer = f.ctx.on('agent/turn-admitting', ({ agent }, next) => agent.id === recipient.agent.id
    ? { kind: 'defer', reason: 'Retain pagination evidence.' } : next())
  try {
    for (let index = 0; index < 3; index++) await f.ctx.messageDelivery.send({ target: { sessionId: recipient.agent.id },
      operationId: operation() as never, messageClass: 'handoff', priority: 'queue', content: `Message ${index}.` })
    await expect.poll(async () => (await f.ctx.sessionLedger.queryMessages({ targetSessionId: recipient.agent.id })).items.length,
      { timeout: 5000 }).toBe(3)
    const legacy = await f.ctx.messageDelivery.list({ targetSessionId: recipient.agent.id })
    expect(legacy.items).toHaveLength(3)
    expect(await f.ctx.messageDelivery.list({ targetSessionId: recipient.agent.id, limit: 1 }))
      .toEqual({ items: legacy.items.slice(0, 1), complete: false })
    const ids: string[] = []
    let cursor: import('@panedesk/dsh-message-delivery').MessageCursor | undefined
    do {
      const page = await f.ctx.messageDelivery.list({ targetSessionId: recipient.agent.id, pagination: true, limit: 1,
        ...(cursor ? { cursor } : {}) })
      expect(page.items).toHaveLength(1)
      ids.push(...page.items.map(item => item.messageId))
      cursor = page.nextCursor
    } while (cursor)
    expect(ids).toEqual(legacy.items.map(item => item.messageId))
    expect(new Set(ids).size).toBe(3)
    expect((await f.ctx.sessionLedger.query({ sessionId: recipient.agent.id })).rows.filter(row => row.kind === 'call')).toHaveLength(0)
    expect((await f.ctx.sessionLedger.queryMessages({ targetSessionId: recipient.agent.id })).items).toHaveLength(3)
  } finally { defer() }
}, 20000)

it('A25 runs the default Session loop before the optional seat plugins are installed', async () => {
  await setup({ onBase: async (ctx) => {
    expect(ctx.get('seats')).toBeUndefined()
    expect(ctx.get('seatEngine')).toBeUndefined()
    const { agent } = await ctx.sessionCreation.create({ sessionId: 'default-session' as never, cwd: process.cwd() })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Neutral default task.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await ctx.sessions.flush(agent.session)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect((await ctx.sessionQuery.readSession(agent.id))?.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed')).toBe(true)
  } })
}, 20000)

it('A26 exposes durable mock-run evidence without claiming a real-model or handover run', async () => {
  const f = await setup()
  await f.save(f.definition())
  const opened = await f.open()
  await f.settle()
  expect(f.model.requests).toHaveLength(1)
  const ledger = await f.ctx.sessionLedger.query({ sessionId: opened.sessionId })
  expect(ledger.rows.some(row => row.kind === 'call' && row.start.provider === 'provider-a')).toBe(true)
}, 20000)

it('A27 retains only neutral fixture source and no credential assignments or forbidden casts', async () => {
  const files = ['acceptance.spec.ts', 'fixtures/source.ts', 'fixtures/clock.ts', 'fixtures/ledger.ts',
    'fixtures/cordis.yml', 'fixtures/seat-table.csv', 'fixtures/seat-table.md']
  const violations: string[] = []
  for (const file of files) {
    const content = await readFile(new URL(file, import.meta.url), 'utf8')
    const privateText = new RegExp(`[${String.fromCharCode(19968)}-${String.fromCharCode(40959)}]`, 'u').test(content)
    const unsafeCast = /as\s+unknown/u.test(content)
    const credential = /(?:api_key|password|token)\s*[:=]\s*["'][^"']{16}/iu.test(content)
    if (privateText || unsafeCast || credential) violations.push(file)
    expect(content.charCodeAt(0)).not.toBe(0xfeff)
  }
  expect(violations).toEqual([])
})

it.each(['idle', 'disabled', 'busy', 'title', 'short'] as const)('A28 handles %s cache maintenance without inserting conversation text', async (scenario) => {
  const time = clock()
  try {
    const f = await setup()
    f.model.retention = scenario === 'short' ? '5m' : '1h'
    await f.save(f.definition('seat-a', { autoKeepAlive: scenario !== 'disabled' }))
    const opened = await f.open()
    await f.settle()
    const agent = f.ctx.agents.get(opened.sessionId)!
    if (scenario === 'title') {
      f.ctx.sessionTitle.rename(agent.session, 'Renamed seat-a')
      await f.ctx.sessions.flush(agent.session)
      expect(await f.seats.list({})).toMatchObject({ sessions: [{ title: 'Renamed seat-a' }] })
      expect(await f.seats.wake({ seat: seatName('seat-a'), sessionId: agent.id, operationId: operation() }))
        .toMatchObject({ status: 'sent', title: 'Renamed seat-a' })
      await expect.poll(() => f.model.requests.length).toBe(2)
      await f.settle()
    }
    if (scenario === 'busy') {
      f.model.hold()
      await f.seats.wake({ seat: seatName('seat-a'), sessionId: agent.id, operationId: operation() })
      await expect.poll(() => f.model.requests.length).toBe(2)
    }
    await f.engine.drive()
    const before = agent.session.snapshotEvents()
    const calls = f.model.requests.length
    time.advance((scenario === 'short' ? 1 : 56) * 60000)
    const result = await measured(`A28 ${scenario}`, async () => { await f.engine.drive(); await f.engine.drive() })
    expect(result.milliseconds).toBeLessThan(5000)
    const renews = scenario === 'idle' || scenario === 'title'
    expect(f.model.requests).toHaveLength(calls + (renews ? 1 : 0))
    expect(agent.session.snapshotEvents()).toEqual(before)
    if (renews) {
      expect(f.model.requests.at(-1)).toMatchObject({ purpose: 'keepalive', maxTokens: 1 })
      const ledger = await f.ctx.sessionLedger.query({ sessionId: agent.id })
      expect(ledger.rows.filter(row => row.kind === 'call' && row.start.purpose === 'keepalive')).toHaveLength(1)
    }
    if (scenario === 'short') expect((await f.effects()).filter(item => item.kind === 'cache/keepalive-skipped')
      .map(item => item.data.reason)).toContain('ttl-too-short')
  } finally { time.close() }
}, 20000)
