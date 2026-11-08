/** Frozen manual and wake openings remain closed and visible after host recovery. */
import { expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as T from '@panedesk/dsh-seat'
import { frozenHost } from '../../../seat/seat-local/tests/frozen-fixture.ts'
import SeatUi from '../src/index.ts'

it.each(['seat.openFrozen', 'seat.wakeFrozen'] as const)('%s closes after restart with a visible warning and no second opening', async (method) => {
  const root = await mkdtemp(join(tmpdir(), 'seat-frozen-restart-'))
  let fixture: Awaited<ReturnType<typeof frozenHost>> | undefined
  try {
    fixture = await frozenHost(root)
    const { h, request, authorize } = fixture
    h.ctx.on('agent/turn-admitting', () => ({ kind: 'defer', reason: 'Hold the first handoff before restart.' }))
    h.ctx.effect(() => h.ctx.get('seatOpeningContexts')!.registerScopeAdmission!({
      recheck: async () => null,
      evaluateTaskScopes: async () => ({ outcome: 'allow', revisions: [] }),
      batch: async (_request, _authority, execute) => execute(),
      open: async (_request, _authority, execute) => execute(),
    }))
    const operationId = `orphan:${method}` as T.SeatOperationId
    const base = request(operationId)
    base.openingContext.openingMode = 'auto'
    base.route.modeCeiling.mode = 'auto'
    h.ctx.effect(() => h.engine.registerPreopenRetention({ sourceId: base.route.sourceId,
      sourceOwnerNodeId: base.route.sourceOwnerNodeId, limitMs: 60000 }))
    await h.engine.setProjectMode({ projectId: h.definition.projectId, mode: 'auto', expectedRevision: 0,
      operationId: 'automatic-project' as T.SeatOperationId })
    const payload = method === 'seat.openFrozen' ? base : { ...base, request: { seat: base.request.seat, operationId } }
    const seats = h.ctx.get('seats')!.withAuthority(await authorize(payload, operationId))
    expect(await (method === 'seat.openFrozen' ? seats.openFrozen!(base) : seats.wakeFrozen!(payload)))
      .toMatchObject(method === 'seat.openFrozen' ? { status: 'queued' } : { status: 'opened', result: { status: 'queued' } })
    // Process identity now reports only a pid, so this process's own delivery registration
    // reads as a live owner and refuses the handoff. Drop it before the opening send.
    const registry = join(root, 'messages', 'nodes', 'node-a', 'registry')
    for (const name of await readdir(registry).catch(() => [] as string[])) await rm(join(registry, name), { force: true })
    await h.engine.drive()
    const open = [...h.engine.journal.projection.opens.values()][0]!
    if (!open) throw new Error(JSON.stringify([...h.engine.journal.projection.pending.values()]))
    expect(open.phase).toBe('opening-pending')
    expect(await h.ctx.messageDelivery.status(open.openingMessageId!)).toMatchObject({ state: 'queued', phase: 'pending' })
    await h.ctx.sessions.flush(h.ctx.agents.get(open.sessionId)!.session)
    await h.close(); fixture = undefined
    const detail = method === 'seat.openFrozen' ? 'restart-manual-opening-closed' : 'restart-source-wake-closed'
    for (let restart = 0; restart < 2; restart++) {
      fixture = await frozenHost(root)
      const host = fixture.h
      host.ctx.on('agent/turn-admitting', async ({ agent }, next) => {
        const upstream = await next()
        if (upstream.kind !== 'allow') return upstream
        const admission = await host.engine.admitTurn(agent.id)
        return admission.status === 'allow' ? upstream : { kind: 'defer', reason: admission.reason }
      })
      await vi.waitFor(async () => {
        await host.engine.drive()
        expect(host.engine.journal.projection.closed.has(open.sessionId)).toBe(true)
      })
      expect(await host.ctx.messageDelivery.status(open.openingMessageId!)).toMatchObject({ state: 'withdrawn' })
      expect(host.ctx.workspaceRegistry.archivedSessionIds).toContain(open.sessionId)
      expect(host.engine.journal.projection.opens.size).toBe(1)
      expect(host.engine.journal.projection.pending.size).toBe(0)
      expect(host.adapter.requests).toHaveLength(0)
      host.ctx.loader.builtins.seatUi = SeatUi
      await host.load('orphan-seat-ui.yml', [{ name: 'cordis:seatUi', config: {} }])
      Object.defineProperty(host.ctx, 'invocation', { configurable: true, value: { peer: { principal: { kind: 'owner' } } } })
      const ui: unknown = host.ctx.get('seatUi')
      if (!(ui instanceof SeatUi)) throw new Error('Seat UI service unavailable')
      const overview = await ui.overview()
      expect(overview.diagnostics?.openings).toEqual([expect.objectContaining({ sessionId: open.sessionId, detail })])
      expect(host.engine.journal.projection.closed.get(open.sessionId)).toMatchObject({ reason: 'manual', detail })
      const ended = [...host.engine.journal.projection.callbacks.values()].filter(row => row.payload.kind === 'window-ended')
      expect(ended).toHaveLength(1)
      expect(ended[0]?.payload).toMatchObject({ reason: 'manual', detail })
      await host.close(); fixture = undefined
    }
  } finally { await fixture?.h.close(); await rm(root, { recursive: true, force: true }) }
}, 30000)
