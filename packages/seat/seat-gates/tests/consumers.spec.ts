import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@panedesk/dsh-tools'
import type { SeatService, SeatEngineService } from '@panedesk/dsh-seat'
import { harness } from '../../tool-seat/tests/harness.ts'
import type {} from '../src/events.ts'
import { installLifecycle } from '../src/lifecycle.ts'
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
