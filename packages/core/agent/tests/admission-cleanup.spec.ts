/** Optional admission callbacks preserve factory ownership and independent failures. */
import { Context } from '@panedesk/cordis'
import { SessionId } from '@panedesk/dsh-session'
import { expect, it, vi } from 'vitest'
import AgentRegistry, { type ResumeAgentOptions } from '../src/index.ts'

it('releases caller preparation before every admission failure callback', async () => {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  const factoryFailure = new Error('factory failure')
  const releaseFailure = new Error('release failure')
  const admissionFailure = new Error('admission cleanup failure')
  const calls: string[] = []
  const factory = vi.fn((): never => { throw factoryFailure })
  ctx.agents.setFactory({ createAgent: factory, resume: factory })
  ctx.on('agent/create-admitting', async ({ options }, next) => {
    options.onAdmissionFailure?.(() => { calls.push('admission-a'); throw admissionFailure })
    options.onAdmissionFailure?.(() => { calls.push('admission-b') })
    return next()
  })
  try {
    await expect(ctx.agents.create({ sessionId: SessionId('window-a'), releasePreparation: () => {
      calls.push('caller'); throw releaseFailure
    } })).rejects.toMatchObject({ errors: [factoryFailure, releaseFailure, admissionFailure] })
    expect(calls).toEqual(['caller', 'admission-a', 'admission-b'])
    expect(factory).toHaveBeenCalledOnce()
  } finally { await ctx.fiber.dispose() }
})

it('rejects resume before the factory and releases admission preparation', async () => {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  const factory = vi.fn((_ctx: Context, _options: ResumeAgentOptions): never => { throw new Error('factory entered') })
  ctx.agents.setFactory({ createAgent: async () => { throw new Error('unused') }, resume: factory })
  const cleanup = vi.fn()
  const remove = ctx.on('agent/resume-admitting', async (payload) => {
    payload.onSettled(cleanup)
    return { kind: 'reject', reason: 'resume refused' }
  })
  try {
    await expect(ctx.agents.resume({ resumeSessionId: SessionId('window-a') })).rejects.toMatchObject({ reason: 'resume refused' })
    expect(cleanup).toHaveBeenCalledOnce()
    expect(factory).not.toHaveBeenCalled()
    remove()
    const options = { resumeSessionId: SessionId('window-a') }
    await expect(ctx.agents.resume(options)).rejects.toThrow('factory entered')
    expect(factory.mock.calls[0]?.[1]).toBe(options)
  } finally { await ctx.fiber.dispose() }
})
