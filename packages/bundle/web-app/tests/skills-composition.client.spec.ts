/** The shipped Skills plugin registers and unloads through a real Loader include. */
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import { SlotRegistry } from '@panedesk/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@panedesk/dsh-client-locale/client'
import * as Skills from '@panedesk/dsh-client-ui-skills/client'
import { expect, it } from 'vitest'

it('loads localized Skills navigation and removes it when its Loader fiber is disposed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-composition-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SlotRegistry)
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    ctx.provide('remote', { skills: {}, session: {} } as never)
    ctx.provide('remote.skills', {} as never)
    ctx.provide('remote.session', {} as never)
    ctx.provide('workspaces', { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } } as never)
    ctx.slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
    const config = join(root, 'cordis.yml')
    await copyFile(new URL('./fixtures/skills/cordis.yml', import.meta.url), config)
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const unsupported = (): never => { throw new Error('Unexpected Loader operation') }
    ctx.loader.internal = {
      version: 'v2', loadCache: new Map(), register: unsupported,
      getOrCreateModuleJob: unsupported, resolveSync: unsupported, load: unsupported,
      async import(specifier: string) {
        if (specifier === '@panedesk/dsh-client-ui-skills/client') return Skills
        throw new Error(`Unexpected plugin: ${specifier}`)
      },
    }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    expect(ctx.slots.entries('settings.section').map(entry => entry.options.id)).toEqual(['skills'])
    locale.setLocale('en')
    expect(locale.bind('settings.skills')('nav')).toBe('Skills')
    locale.setLocale('zh')
    expect(locale.bind('settings.skills')('nav')).toBe('技能')
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'skills')
    if (entry?.fiber === undefined) throw new Error('Skills plugin did not mount')
    await entry.fiber.dispose()
    expect(ctx.slots.entries('settings.section')).toEqual([])
  } finally {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  }
})
