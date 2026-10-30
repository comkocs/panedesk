import { Context } from '@panedesk/cordis'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configurationFixture } from '../../../settings/settings/tests/configuration-fixture.ts'
import { describe, expect, it } from 'vitest'
import * as HostPlugin from '../src/index.ts'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import { plainConfig } from '../../../settings/settings/src/schema.ts'
import {
  Config, apply,
} from '@panedesk/dsh-client-locale'


describe('locale host', () => {
  it('registers an open locale preference with the Host settings lifecycle', async () => {
    const ctx = new Context()
    const configuration = await liveConfig(ctx, { Config, apply })
    const { fiber } = configuration
    expect(plainConfig(configuration.fiber.config)).toEqual({})
    await configuration.update({ preference: 'en' })
    expect(plainConfig(configuration.fiber.config)).toEqual({ preference: 'en' })
    await configuration.update({ preference: 'pt-BR' })
    expect(plainConfig(configuration.fiber.config)).toEqual({ preference: 'pt-BR' })
    await expect(configuration.update({ preference: 'bad locale' })).rejects.toThrow()
    await expect(configuration.update({ preference: '123' })).rejects.toThrow()
    await fiber.dispose()
  })
})

it.each(['profile', 'runtime'] as const)('preserves %s enablement across language changes', async (enablement) => {
  const f = await configurationFixture({ schema: Config, apply, hmr: false })
  await f.ctx.fiber.dispose()
  const bundlePath = join(f.profile.dir, 'node_modules', 'test-bundle', 'cordis.patch.yml')
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as Array<{
    insert: Array<{ id: string; disabled?: boolean }>
  }>
  const optional = bundle[0]!.insert.find(row => row.id === 'second')!
  optional.disabled = true
  writeFileSync(bundlePath, JSON.stringify(bundle))
  if (enablement === 'profile') writeFileSync(f.profile.patchPath, '- id: second\n  disabled: false\n')
  const ctx = await f.start()
  const entry = [...ctx.loader.entries()].find(row => row.options.id === 'second')!
  if (enablement === 'runtime') { await entry.update({ disabled: false }); await ctx.loader.await() }
  const fiber = entry.fiber
  expect(fiber?.uid).toBeTruthy()
  for (const preference of ['zh', 'en', 'zh']) {
    await ctx.settings.mutate('first', [{ op: 'set', path: ['preference'], value: preference }])
    expect(entry.disabled).toBe(false)
    expect(entry.fiber).toBe(fiber)
    if (enablement === 'profile') {
      expect(readFileSync(f.profile.patchPath, 'utf8')).toMatch(/id: second\s+disabled: false/)
    }
    expect(ctx.settings.describe().find(row => row.ns === 'first')?.value).toMatchObject({ preference })
  }
  await ctx.fiber.dispose()
  const restarted = await f.start()
  const restored = [...restarted.loader.entries()].find(row => row.options.id === 'second')!
  expect(restored.disabled).toBe(enablement === 'runtime')
  if (enablement === 'profile') expect(restored.fiber?.uid).toBeTruthy()
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(ctx => ctx.plugin(HostPlugin)))
