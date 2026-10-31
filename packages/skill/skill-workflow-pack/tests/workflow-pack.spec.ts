/** Loader composition and lifecycle coverage for the bundled project guide. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import Include from '@panedesk/cordis-plugin-include'
import SkillRegistry from '@panedesk/dsh-skill'
import * as WorkflowPack from '../src/index.ts'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../../templates/workflow-pack/', import.meta.url))

it('discovers the first-window guide through cordis.yml and removes it on disposal', async () => {
  const ctx = new Context()
  const directory = await mkdtemp(join(tmpdir(), 'workflow-pack-loader-'))
  try {
    const profile = join(directory, 'cordis.yml')
    await writeFile(profile, await readFile(new URL('./cordis.yml', import.meta.url)))
    ctx.baseUrl = `${pathToFileURL(directory).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const configured = {
      ...WorkflowPack,
      apply: (scope: Context) => { WorkflowPack.apply(scope, { assetRoot: root }) },
    }
    const modules = new Map<string, unknown>([
      ['@panedesk/dsh-skill', SkillRegistry],
      ['@panedesk/dsh-skill-workflow-pack', configured],
    ])
    ctx.loader.internal = {
      version: 'v2', loadCache: new Map(),
      register() { throw new Error('Unexpected register') },
      getOrCreateModuleJob() { throw new Error('Unexpected module job') },
      resolveSync() { throw new Error('Unexpected resolution') },
      load() { throw new Error('Unexpected load') },
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected plugin: ${specifier}`)
        return modules.get(specifier)
      },
    }
    const entry = await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
    await ctx.loader.await()
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['workflow-pack'])
    const guide = await ctx.skills.get('workflow-pack')
    expect(guide?.content).toBe(await readFile(new URL('../../../../templates/workflow-pack/getting-started.md', import.meta.url), 'utf8'))
    expect(guide?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    const registry = ctx.skills
    const guideEntry = [...ctx.loader.resolve(entry).subtree!.entries()].find(item => item.options.name === '@panedesk/dsh-skill-workflow-pack')!
    await guideEntry.fiber!.dispose()
    expect(await registry.list()).toEqual([])
  } finally {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it('discovers the complete pack using the source-launch default location', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(WorkflowPack)
    expect((await ctx.skills.get('workflow-pack'))?.resourceBase).toEqual({ kind: 'directory', path: root.replace(/\/$/, '') })
  } finally { await ctx.fiber.dispose() }
})

it('refuses relative resource locations before registering candidates', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    expect(() => { WorkflowPack.apply(ctx, { assetRoot: 'relative' }) }).toThrow('absolute')
    expect(await ctx.skills.list()).toEqual([])
  } finally { await ctx.fiber.dispose() }
})
