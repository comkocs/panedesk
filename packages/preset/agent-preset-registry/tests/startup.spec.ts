/** Claude Code presets are available after normal registry activation. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@panedesk/cordis'
import Loader from '@panedesk/cordis-plugin-loader'
import LlmRuntime, { LlmAdapter, type LlmModelInfo } from '@panedesk/dsh-llm'
import SessionProjectionRegistry from '@panedesk/dsh-session-projection'
import SystemPrompt from '@panedesk/dsh-system-prompt'
import AgentPresets from '../src/index.ts'

class CatalogAdapter extends LlmAdapter {
  override providerInfo(provider: string) { return { id: provider, name: provider } }
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'reader-model', name: 'reader-model' }])
  }
  override stream(): AsyncIterable<never> { return (async function* () { /* catalog only */ })() }
}

const ctx = new Context()
let root: string | undefined

afterEach(async () => {
  await ctx.fiber.dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

it('resolves home and workspace agents on startup without an explicit import', async () => {
  root = await mkdtemp(join(tmpdir(), 'claude-agent-startup-'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  for (const [directory, name] of [[home, 'home-reader'], [workspace, 'project-reader']] as const) {
    await mkdir(join(directory, '.claude', 'agents'), { recursive: true })
    await writeFile(join(directory, '.claude', 'agents', `${name}.md`),
      `---\nname: ${name}\ndescription: Reads files.\nmodel: reader-model\ntools: Read\n---\nRead the requested files.\n`)
  }
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.spyOn(process, 'cwd').mockReturnValue(workspace)
  ctx.baseUrl = new URL('./fixtures/', import.meta.url).href
  await ctx.plugin(Loader)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['custom-reader'], new CatalogAdapter())
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(AgentPresets, { default: 'home-reader' })

  for (const name of ['home-reader', 'project-reader']) {
    await expect(ctx.agentPresets.resolve(name)).resolves.toMatchObject({
      id: name,
      executionPolicy: { provider: 'custom-reader', model: 'reader-model', allowedTools: ['read'] },
    })
  }
})
