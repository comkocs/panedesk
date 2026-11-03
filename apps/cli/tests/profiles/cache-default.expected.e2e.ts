/** Default cache controls and the user-facing disabled patch through all model-running protocols. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@panedesk/cordis'
import { JournalSessionLedger } from '@panedesk/dsh-session-ledger'
import { DeepSeekHarness } from '@panedesk/dsh-sdk-client'
import { runLoaderSmoke } from '@panedesk/dsh-loader-smoke'
import {
  launchAcpTestAgent, materializeProfilePatch, normalizedHeaders, fixtureContext,
  latestPersistedSessionPaths, parseToolSchemasSnapshot, restorePinnedToolSchemas,
} from '@panedesk/dsh-session-snapshot'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const fixture = join(root, 'snapshots/session/text-turn/session.v1.jsonl')
const composition = join(root, 'snapshots/session/text-turn')
const binScript = join(root, 'apps/cli/src/bin.ts')
const tsconfigPath = join(root, 'tsconfig.json')

async function persisted(directory: string): Promise<string[]> {
  const paths = latestPersistedSessionPaths(await readdir(directory, { recursive: true }))
  return Promise.all(paths.map(path => readFile(join(directory, path), 'utf8')))
}

describe('default profile cache request compatibility', () => {
  it.each(['headless', 'sdk', 'acp'] as const)('%s adds only cache controls and preserves accounting when disabled', async (profile) => {
    const expectedText = await readFile(join(composition, 'writer.expected.jsonl'), 'utf8')
    const schemas = parseToolSchemasSnapshot(await readFile(join(composition, 'tool-schemas.expected.json'), 'utf8'))
    const expected = normalizedHeaders(expectedText, fixtureContext(expectedText))
      .map(header => restorePinnedToolSchemas(header, schemas.initial))
    expect(expected).toHaveLength(1)
    for (const disabled of [true, false]) {
      const root = await mkdtemp(join(tmpdir(), 'profile-cache-'))
      const cwd = join(root, 'workspace')
      const home = join(root, 'home')
      await mkdir(cwd)
      const reader = new Context()
      try {
        const patches = ['cordis.yml', 'cordis.snapshot.yml', 'model.cordis.yml']
          .map((name, index) => materializeProfilePatch(join(composition, name), cwd, profile, cwd, index, home))
        const overlay = join(cwd, 'cache.patch.yml')
        await writeFile(overlay, JSON.stringify([
          { id: 'llm-cache', disabled },
          { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
          ...(profile === 'acp' ? [{ id: 'acp', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }] : []),
        ]))
        patches.push(overlay)
        const env = {
          DSH_SNAPSHOT: 'replay', DSH_SNAPSHOT_FILE: fixture,
          DSH_SNAPSHOT_PROVIDER: 'deepseek-official', DSH_SNAPSHOT_MODEL: 'deepseek-v4-flash',
          PANEDESK_HOME: home, PANEDESK_AGENTS_HOME: join(cwd, '.agents'), PANEDESK_TELEMETRY_DISABLED: '1',
        }
        const prompt = 'Reply with exactly the single word PONG and do not use any tools.'
        if (profile === 'headless') {
          await runLoaderSmoke({ label: 'default cache headless', cwd, binScript, configPath: overlay, tsconfigPath,
            sourceImport: 'tsx/esm', env, binArgs: ['--profile', profile, ...patches.flatMap(path => ['--patch', path]), prompt] })
        } else if (profile === 'sdk') {
          const harness = new DeepSeekHarness({ profile, patches, dshHome: home, processCwd: cwd, cwd, env,
            provider: 'deepseek-official', model: 'deepseek-v4-flash' })
          try { await harness.start(); await harness.session('cache-probe').run(prompt) } finally { await harness.close() }
        } else {
          const combined = join(cwd, 'combined.patch.yml')
          const contents = await Promise.all(patches.map(path => readFile(path, 'utf8')))
          // Each materialized file is a YAML patch list; concatenation keeps their precedence.
          await writeFile(combined, contents.slice(0, -1).join('\n') + '\n'
            + '- id: llm-cache\n  disabled: ' + String(disabled) + '\n'
            + '- id: acp\n  config:\n    provider: deepseek-official\n    model: deepseek-v4-flash\n')
          const agent = launchAcpTestAgent({ cwd, env: { ...env, DSH_SNAPSHOT: undefined },
            agent: { binScript, configPath: combined, profile, tsconfigPath } })
          try {
            await agent.client.initialize({ protocolVersion: 1, clientCapabilities: {} })
            const session = await agent.client.newSession({ cwd, mcpServers: [] })
            await agent.client.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text: prompt }] })
          } finally { await agent.close() }
        }
        const logs = await persisted(join(home, 'sessions'))
        expect(logs).toHaveLength(1)
        const text = logs[0]!
        const headers = normalizedHeaders(text, fixtureContext(text))
        expect(headers).toEqual(disabled ? expected : expected.map((header) => {
          if (header === null || typeof header !== 'object' || !('config' in header)
            || header.config === null || typeof header.config !== 'object') throw new Error('Expected a recorded request config')
          return { ...header, config: { ...header.config, cache: { retention: 'default', key: '{{sessionId}}' } } }
        }))
        if (disabled) expect(headers[0]).not.toHaveProperty('config.cache')
        const ledger = new JournalSessionLedger(reader, { dshHome: home })
        const rows = (await ledger.snapshot()).rows.filter(row => row.kind === 'call')
        expect(rows).toHaveLength(1)
        expect(rows[0]?.finish?.endReason).toBe('completed')
      } finally { await reader.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
    }
  })
})
