/** Claude Code agent definitions become named presets. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import type { Context } from '@panedesk/cordis'
import { LlmAdapter, type LlmModelInfo } from '@panedesk/dsh-llm'
import { harness } from './harness.ts'

const contexts: Context[] = []
const temps: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** One provider advertising exactly the models named in `ids`. */
class CatalogAdapter extends LlmAdapter {
  constructor(private readonly ids: readonly string[]) { super() }
  override providerInfo(provider: string) { return { id: provider, name: provider } }
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.ids.map(id => ({ provider, id, name: id })))
  }
  override stream(): AsyncIterable<never> { return (async function* () { /* catalog only */ })() }
}

const USER_AGENT = `---
name: reader-luna
description: Reads files and reports findings.
model: gpt-6-luna
tools: Read, Grep, Glob, Bash, MysteryTool
effort: high
---
Read only what the task names, then report.
`
const PROJECT_AGENT = `---
name: reader-luna
description: Project reader with a narrower tool set.
model: gpt-6-terra
tools: Read, Grep
---
Project instructions override the user definition.
`

/** Write both definitions and boot a registry that reads them. */
async function setup(): Promise<{ ctx: Context; home: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), 'claude-agents-'))
  temps.push(root)
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  await mkdir(join(home, '.claude', 'agents'), { recursive: true })
  await mkdir(join(workspace, '.claude', 'agents'), { recursive: true })
  await writeFile(join(home, '.claude', 'agents', 'reader-luna.md'), USER_AGENT)
  await writeFile(join(workspace, '.claude', 'agents', 'reader-luna.md'), PROJECT_AGENT)
  const ctx = await harness()
  contexts.push(ctx)
  ctx.llm.registerAdapter(['custom-luna'], new CatalogAdapter(['gpt-6-luna']))
  ctx.llm.registerAdapter(['custom-terra'], new CatalogAdapter(['gpt-6-terra']))
  await ctx.plugin({
    inject: ['agentPresets'],
    async* apply(child: Context) { await child.agentPresets.importClaudeAgents({ home, workspace }) },
  })
  return { ctx, home, workspace }
}

describe('claude code agent definitions', () => {
  it('lists and resolves definitions, with the project copy overriding the user copy', async () => {
    const { ctx } = await setup()
    const listed = await ctx.agentPresets.list()
    expect(listed.map(row => row.id)).toEqual(['reader-luna'])
    expect(listed[0]?.description).toBe('Project reader with a narrower tool set.')
    const preset = await ctx.agentPresets.resolve('reader-luna')
    expect(preset.broken).toBeUndefined()
    expect(preset.executionPolicy).toMatchObject({
      provider: 'custom-terra', model: 'gpt-6-terra', reasoningEffort: 'high',
      allowedTools: ['read', 'grep'],
    })
    expect(preset.executionPolicyDigest).toMatch(/^[a-f\d]{64}$/)
    const document = await ctx.agentPresets.readDocument('reader-luna')
    const rows = load(document.content) as { config?: { text?: string } }[]
    expect(rows[0]?.config?.text).toContain('Project instructions override the user definition.')
  })

  it('marks a preset broken, naming the cause, when no configured provider advertises its model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-agents-'))
    temps.push(root)
    const home = join(root, 'home')
    await mkdir(join(home, '.claude', 'agents'), { recursive: true })
    await writeFile(join(home, '.claude', 'agents', 'reader-luna.md'), USER_AGENT.replace('model: gpt-6-luna', 'model: gpt-6-unknown'))
    const ctx = await harness()
    contexts.push(ctx)
    ctx.llm.registerAdapter(['custom-luna'], new CatalogAdapter(['gpt-6-luna']))
    await ctx.plugin({
      inject: ['agentPresets'],
      async* apply(child: Context) { await child.agentPresets.importClaudeAgents({ home, workspace: root }) },
    })
    const unrouted = (await ctx.agentPresets.list()).find(row => row.id === 'reader-luna')
    expect(unrouted?.broken).toMatch(/gpt-6-unknown/)
  })

  it('keeps unmapped tool names out of the allowlist and records them in the preset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-agents-'))
    temps.push(root)
    const home = join(root, 'home')
    await mkdir(join(home, '.claude', 'agents'), { recursive: true })
    await writeFile(join(home, '.claude', 'agents', 'reader-luna.md'), USER_AGENT)
    const ctx = await harness()
    contexts.push(ctx)
    ctx.llm.registerAdapter(['custom-luna'], new CatalogAdapter(['gpt-6-luna']))
    await ctx.plugin({
      inject: ['agentPresets'],
      async* apply(child: Context) { await child.agentPresets.importClaudeAgents({ home, workspace: root }) },
    })
    const preset = await ctx.agentPresets.resolve('reader-luna')
    expect(preset.broken).toBeUndefined()
    expect(preset.executionPolicy?.provider).toBe('custom-luna')
    expect(preset.executionPolicy?.model).toBe('gpt-6-luna')
    expect(preset.executionPolicy?.allowedTools).toEqual(['read', 'grep', 'glob', 'bash'])
    expect(preset.executionPolicy?.allowedTools).not.toContain('MysteryTool')
    const listed = await ctx.agentPresets.list()
    expect(listed.find(row => row.id === 'reader-luna')?.description).toMatch(/MysteryTool/)
  })
})
