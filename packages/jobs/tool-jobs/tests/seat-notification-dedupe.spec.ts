import { expect, it, vi, onTestFinished } from 'vitest'
import { Context } from '@panedesk/cordis'
import AgentRegistry, { type Agent } from '@panedesk/dsh-agent'
import SessionStore, { SessionId } from '@panedesk/dsh-session'
import SystemPrompt from '@panedesk/dsh-system-prompt'
import ToolRuntime from '@panedesk/dsh-tools'
import LocalJobRegistry from '@panedesk/dsh-jobs-local'
import type { JobEvent, JobNotifications, JobOutcome } from '@panedesk/dsh-jobs'
import * as ToolJobs from '../src/index.ts'

async function setup(status: 'idle' | 'running', durable: boolean, uncertain = false) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const wake = vi.fn()
  if (durable) {
    const bridge: JobNotifications = { prepare: () => ({
      running() {},
      settled(observation) {
        wake(observation)
        if (uncertain) throw new Error('acknowledgement unavailable after acceptance')
      },
    }) }
    ctx.provide('jobNotifications', bridge)
  }
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolJobs)
  const session = ctx.sessions.create(SessionId('owner'))
  const followup = vi.fn()
  const inject = vi.fn()
  const owner: Agent = {
    id: session.id, session, ctx: ctx.extend(), options: {}, status,
    inbox: { nextTurn: [], nextStep: [], clear() {}, append() {}, prepend() {},
      replace: () => false, remove: () => false, splice: () => [] },
    send() {}, followup, inject, steer() {}, cancel() {},
    whenIdle: async () => {}, runMaintenance: operation => operation(new AbortController().signal),
  }
  await ctx.agents.register(owner)
  const events: JobEvent[] = []
  ctx.jobs.events.subscribe({ owners: 'all' }, (event) => { events.push(event) })
  const done = Promise.withResolvers<JobOutcome>()
  const id = ctx.jobs.start({ kind: 'bash', label: 'task', owner: owner.id,
    run: () => ({ done: done.promise, cancel: () => { done.resolve({ status: 'killed' }) } }),
  })
  return { ctx, owner, wake, followup, inject, events, done, id }
}

it.each(['idle', 'running'] as const)('preserves the exact legacy completion for a %s owner without a bridge', async (status) => {
  const test = await setup(status, false)
  test.done.resolve({ status: 'completed' })
  await vi.waitFor(() => { expect(test.events.some(event => event.type === 'settled')).toBe(true) })
  const receiver = status === 'idle' ? test.followup : test.inject
  const other = status === 'idle' ? test.inject : test.followup
  expect(receiver).toHaveBeenCalledTimes(1)
  expect(other).not.toHaveBeenCalled()
  expect(test.wake).not.toHaveBeenCalled()
  expect(receiver.mock.calls[0]?.[0]).toMatchObject({
    content: [{ type: 'text', text: `background job ${test.id} (bash: task) finished [status: completed]. Read its output with job_output.` }],
    source: { kind: 'tool-jobs', form: 'notice', summary: 'bash task [status: completed]' },
  })
  const settled = test.events.filter(event => event.type === 'settled')
  expect(settled).toHaveLength(1)
  expect(settled[0]).toMatchObject({ awaited: false, cause: 'producer' })
  expect(settled[0]).not.toHaveProperty('notificationOwner')
})

it.each(['idle', 'running'] as const)('delivers once through the durable bridge for a %s owner without hiding settlement', async (status) => {
  const test = await setup(status, true)
  test.ctx.set('jobNotifications', undefined)
  const terminalAt = performance.now()
  test.done.resolve({ status: 'completed' })
  await vi.waitFor(() => { expect(test.wake).toHaveBeenCalledTimes(1) })
  expect(performance.now() - terminalAt).toBeLessThanOrEqual(5000)
  expect(test.followup).not.toHaveBeenCalled()
  expect(test.inject).not.toHaveBeenCalled()
  expect(test.wake).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    outcome: { status: 'completed' }, eventKind: 'job', messageClass: 'handoff', delivery: 'steer',
  }))
  expect(test.events.filter(event => event.type === 'settled')).toMatchObject([
    { awaited: false, cause: 'producer', notificationOwner: 'durable', job: { id: test.id, status: 'completed' } },
  ])
})

it('does not redeliver through legacy consumers after uncertain durable acceptance', async () => {
  const test = await setup('idle', true, true)
  test.done.resolve({ status: 'completed' })
  await vi.waitFor(() => { expect(test.wake).toHaveBeenCalledTimes(1) })
  expect(test.ctx.jobs.notificationState(test.id, test.owner.id)).toBe('unavailable')
  expect(test.followup).not.toHaveBeenCalled()
  expect(test.inject).not.toHaveBeenCalled()
  expect(test.events.filter(event => event.type === 'settled')).toMatchObject([
    { awaited: false, notificationOwner: 'durable' },
  ])
})
