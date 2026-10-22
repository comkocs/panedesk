import { Context } from '@panedesk/cordis'
import { createLaunchEnvironmentSnapshot } from '@panedesk/dsh-launch-environment'
import { expect, it } from 'vitest'
import { resolveLedgerIdentity } from '../src/ledger-identity.ts'

it.each(['startup', 'environment', 'settings', 'free'] as const)('resolves ledger attribution from %s with lower-priority fallbacks', (source) => {
  const ctx = new Context()
  const settings = source === 'free' ? {} : { seat: 'settings-seat', window: 'settings-window', taskId: 'settings-task' }
  const values = source === 'startup' || source === 'environment'
    ? { PANEDESK_SEAT: 'environment-seat', PANEDESK_WINDOW: 'environment-window', PANEDESK_TASK_ID: 'environment-task' } : {}
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values }]))
  if (source === 'startup') ctx.provide('ledgerStartupIdentity', { seat: 'startup-seat', window: 'startup-window', taskId: 'startup-task' })
  expect(resolveLedgerIdentity(ctx, settings)).toEqual({
    seat: source === 'free' ? 'free' : `${source}-seat`, window: source === 'free' ? 'free' : `${source}-window`,
    taskId: source === 'free' ? 'free' : `${source}-task`, identitySource: source,
  })
})

it('resolves partial labels independently without losing lower-priority values', () => {
  const ctx = new Context()
  ctx.provide('ledgerStartupIdentity', { seat: 'seat-a' })
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: { PANEDESK_WINDOW: 'window-a' } }]))
  expect(resolveLedgerIdentity(ctx, { taskId: 'task-a' })).toEqual({ seat: 'seat-a', window: 'window-a', taskId: 'task-a', identitySource: 'startup' })
})
