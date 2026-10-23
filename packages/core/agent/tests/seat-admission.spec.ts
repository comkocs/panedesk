/** Creation admission runs before factories and always releases temporary ownership. */
import { Context } from '@panedesk/cordis'
import { SessionId } from '@panedesk/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import AgentRegistry, { AgentCreateAdmissionError } from '../src/index.ts'

describe('creation admission', () => {
  it('preserves policy choice data and headless commands without entering the factory', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const factory = vi.fn((): never => { throw new Error('factory entered') })
    ctx.agents.setFactory({ createAgent: factory, resume: factory })
    const rejection = Object.assign(new Error('directory choice required'), {
      choices: ['switch-directory', 'temporary-seat-window', 'traditional-free'] as const,
      candidates: [{ seat: 'seat-b', cwd: '/workspace-b', command: 'seat open seat-b --cwd /workspace-b' }],
    })
    ctx.on('agent/create-admitting', async () => { throw rejection })
    try {
      await expect(ctx.agents.create({ sessionId: SessionId('window-a') })).rejects.toBe(rejection)
      expect(new Set(rejection.choices)).toEqual(new Set(['switch-directory', 'temporary-seat-window', 'traditional-free']))
      expect(rejection.candidates).toEqual([{ seat: 'seat-b', cwd: '/workspace-b', command: 'seat open seat-b --cwd /workspace-b' }])
      expect(factory).not.toHaveBeenCalled()
      expect(ctx.agents.list()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects before factory, setup or publication and releases the preparation', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const factory = vi.fn((): never => { throw new Error('factory entered') })
    ctx.agents.setFactory({ createAgent: factory, resume: factory })
    const setup = vi.fn()
    const releasePreparation = vi.fn()
    const announced = vi.fn()
    ctx.on('agent/created', announced)
    ctx.on('agent/create-admitting', async () => ({ kind: 'reject', reason: 'choice-required' }))
    try {
      await expect(ctx.agents.create({ sessionId: SessionId('window-a'), setup, releasePreparation }))
        .rejects.toMatchObject({ name: AgentCreateAdmissionError.name, reason: 'choice-required' })
      expect(factory).not.toHaveBeenCalled()
      expect(setup).not.toHaveBeenCalled()
      expect(announced).not.toHaveBeenCalled()
      expect(releasePreparation).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })

  it('delegates absent or disposed admission listeners and releases factory failures', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const failure = new Error('factory failure')
    const factory = vi.fn((): never => { throw failure })
    ctx.agents.setFactory({ createAgent: factory, resume: factory })
    const remove = ctx.on('agent/create-admitting', async (_payload, next) => next())
    const releasePreparation = vi.fn()
    try {
      await expect(ctx.agents.create({ sessionId: SessionId('window-a'), releasePreparation })).rejects.toBe(failure)
      remove()
      await expect(ctx.agents.create({ sessionId: SessionId('window-b') })).rejects.toBe(failure)
      expect(factory).toHaveBeenCalledTimes(2)
      expect(releasePreparation).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })
})
