/** Client contributions and generated Remote ownership leave with the plugin fiber. */
import { Context, Service } from '@panedesk/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { TypertRemoteContribution } from '@panedesk/dsh-typert-protocol'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

it('withdraws locale, resources, overlay and generated Remote registrations on disposal', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const unmount = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(_contribution: TypertRemoteContribution) { return unmount }
  }
  new Remote()
  ctx.provide('remote.seatApprovals', {} as never)
  const dictionaries = new Map<string, unknown>(), resources = new Set<string>(), entries = new Set<string>()
  ctx.provide('locale', { register: (name: string, value: unknown) => {
    dictionaries.set(name, value)
    return () => { dictionaries.delete(name) }
  } } as never)
  ctx.provide('resources', { register: ({ protocol }: { protocol: string }) => {
    resources.add(protocol)
    return () => { resources.delete(protocol) }
  } } as never)
  class Slots extends Service {
    constructor() { super(ctx, 'slots') }
    inject(_name: string, register: () => () => void) { return this.ctx.effect(register) }
    register({ name }: { name: string }) {
      entries.add(name)
      return () => { entries.delete(name) }
    }
  }
  new Slots()
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  expect(dictionaries.get('seatApprovals')).toEqual({ zh, en })
  expect([...resources]).toEqual(['seat-approvals', 'seat-approval-operation'])
  expect([...entries]).toEqual(['shell.overlay'])
  await fiber.dispose()
  expect(dictionaries.size).toBe(0)
  expect(resources.size).toBe(0)
  expect(entries.size).toBe(0)
  expect(unmount).toHaveBeenCalledOnce()
})
