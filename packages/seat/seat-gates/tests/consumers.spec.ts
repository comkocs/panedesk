import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@panedesk/dsh-tools'
import type { GateContext, SeatGateService, SeatService, SeatEngineService } from '@panedesk/dsh-seat'
import { harness } from '../../tool-seat/tests/harness.ts'
import { installConsumers } from '../src/consumers.ts'
import { installLifecycle } from '../src/lifecycle.ts'
import { builtinCriterion } from '../src/policies.ts'
import { GateRegistry } from '../src/registry.ts'
import { config, profile, seatStub, engineStub } from './harness.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'seat-gates-consumer-'))
  roots.push(path)
  await mkdir(join(path, 'memory'))
  return path
}

describe('executor policy consumers', () => {
  it('denies a free-window memory write through the real tool executor without executing it', async () => {
    const home = await root()
    const { ctx, execute } = await harness()
    const journal = engineStub()
    ctx.provide('seatEngine', journal.engine as SeatEngineService)
    const seats = seatStub({ ...profile, memoryDirectories: [join(home, 'memory')] })
    ctx.provide('seats', seats as SeatService)
    ctx.provide('seatLocalRead', seats)
    const definition = { id: 'memory' as import('@panedesk/dsh-seat').GateId, name: 'memory', hook: 'before-memory-write' as const,
      criterion: { type: 'memory' as import('@panedesk/dsh-seat').GateCriterionId, parameters: {} },
      alternative: 'Use the owning seat.', expiresAt: null, enabled: true, revision: 1, order: 0 }
    const registry = new GateRegistry(journal.engine, [definition], Date.now)
    registry.register(builtinCriterion(ctx, config, 'memory'))
    const gates = { evaluate: (context: GateContext) => registry.evaluate(context) } as SeatGateService
    installConsumers(ctx, config, gates)
    const run = vi.fn(async () => 'written')
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'write', description: 'Write a file.',
      parameters: { path: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: run })))
    try {
      const result = await execute('write', { path: join(home, 'memory/note.md') })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('owning seat')
      expect(run).not.toHaveBeenCalled()
      expect(journal.effects).toEqual([expect.objectContaining({ kind: 'gate/hit' })])
      expect((await execute('write', { path: join(home, 'ordinary.md') })).isError).toBe(false)
      expect(run).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })
  it('checks bound-seat destinations against its own memory roots and emits a coded refusal', async () => {
    const home = await root()
    const { ctx, agent, execute } = await harness()
    const journal = engineStub()
    ctx.provide('seatEngine', journal.engine as SeatEngineService)
    const memory = join(home, 'memory')
    const seats = seatStub({ ...profile, memoryDirectories: [memory, join(home, 'other-memory')] }, {
      kind: 'seat', sessionId: agent.session.id, seat: profile.seat, projectId: profile.projectId,
      nodeId: 'node-a' as GateContext['nodeId'], bindingSource: 'seat-definition', identitySource: 'settings',
      openOperationId: 'open-a' as GateContext['operationId'], seatRevision: 1, relatedTaskIds: [], directories: [],
      memoryDirectories: [memory], subscriptions: [], openingDigest: 'opening-a' as import('@panedesk/dsh-seat').SeatDigest,
    })
    ctx.provide('seats', seats as SeatService)
    ctx.provide('seatLocalRead', seats)
    const definition = { id: 'memory' as import('@panedesk/dsh-seat').GateId, name: 'memory', hook: 'before-memory-write' as const,
      criterion: { type: 'memory' as import('@panedesk/dsh-seat').GateCriterionId, parameters: {} },
      alternative: 'Use this seat memory.', expiresAt: null, enabled: true, revision: 1, order: 0 }
    const registry = new GateRegistry(journal.engine, [definition], Date.now)
    registry.register(builtinCriterion(ctx, config, 'memory'))
    installConsumers(ctx, config, { evaluate: (context: GateContext) => registry.evaluate(context) } as SeatGateService)
    const run = vi.fn(async () => 'written')
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'write', description: 'Write a file.',
      parameters: { path: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: run })))
    const editor = vi.fn(async () => 'edited')
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'str_replace_editor', description: 'Edit or view a file.',
      parameters: { command: { type: 'string', required: true }, path: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: editor })))
    try {
      expect((await execute('write', { path: join(memory, 'note.md') })).isError).toBe(false)
      for (const path of [join(home, 'outside.md'), join(home, 'memory-sibling/note.md')]) {
        expect((await execute('write', { path })).isError).toBe(false)
      }
      const denied = await execute('write', { path: join(home, 'other-memory/note.md') })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('memory-seat-mismatch')
      expect(run).toHaveBeenCalledTimes(3)
      for (const command of ['create', 'str_replace', 'insert']) {
        expect((await execute('str_replace_editor', { command, path: join(home, 'other-memory/note.md') })).isError).toBe(true)
      }
      expect(editor).not.toHaveBeenCalled()
      expect((await execute('str_replace_editor', { command: 'view', path: join(home, 'other-memory/note.md') })).isError).toBe(false)
      expect(editor).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })
  it('records one clock message per turn and audits external memory changes as unknown on flush', async () => {
    const home = await root()
    const file = join(home, 'memory/note.md')
    await writeFile(file, 'before')
    const { ctx, agent, execute } = await harness()
    const journal = engineStub()
    ctx.provide('seatEngine', journal.engine as SeatEngineService)
    const seats = seatStub({ ...profile, memoryDirectories: [join(home, 'memory')] })
    ctx.provide('seats', seats as SeatService)
    ctx.provide('seatLocalRead', seats)
    installLifecycle(ctx, config)
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'probe', description: 'Read data.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'data' })))
    try {
      await ctx.serial('agent/input-preparing', { agent, turn: 1, step: 1, signal: new AbortController().signal })
      const first = await execute('probe', {})
      const second = await execute('probe', {})
      expect(JSON.stringify(first.content)).toContain('system-clock')
      expect(JSON.stringify(second.content)).not.toContain('system-clock')
      await writeFile(file, 'after')
      await ctx.serial('agent/ending', { agent })
      expect(journal.effects).toHaveLength(1)
      const audit = journal.effects[0]
      expect(audit?.kind).toBe('memory/audit')
      if (audit?.kind !== 'memory/audit') throw new Error('Missing audit.')
      expect(audit.data).toMatchObject({ attribution: 'unknown', complete: true })
      expect(audit.data.paths.map(item => item.path)).toEqual([file])
      await ctx.serial('agent/input-preparing', { agent, turn: 2, step: 1, signal: new AbortController().signal })
      expect(JSON.stringify((await execute('probe', {})).content)).toContain('system-clock')
    } finally { await ctx.fiber.dispose() }
  })
})
