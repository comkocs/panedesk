/** The standalone SDK-minimal bundle's complete declared Cordis tree. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@panedesk/cordis-plugin-include'

function packageName(specifier: string): string {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!
}

describe('dsh-sdk-minimal bundle', () => {
  it('declares one standalone allowlisted tree with every row dependency', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const patches = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    ) as Array<{ insert?: Array<{ id?: string; inject?: string[]; name?: string; config?: Record<string, unknown>; disabled?: unknown }> }>
    expect(patches).toHaveLength(1)
    const rows = patches[0]?.insert ?? []
    expect(rows.map(row => [row.id, row.name])).toEqual([
      ['sdk-app-startup', '@panedesk/dsh-sdk-app'],
      ['sdk-jsonrpc-server', '@panedesk/dsh-sdk-jsonrpc-server'],
      ['deepseek-llm-api-extensions', '@panedesk/dsh-deepseek-llm-api-extensions'],
      ['session-log-deepseek', '@panedesk/dsh-session-log-deepseek'],
      ['plugin-package-inventory-deepseek', '@panedesk/dsh-plugin-package-inventory-deepseek'],
      ['llm-deepseek', '@panedesk/dsh-llm-deepseek-api-key'],
      ['sandbox', '@panedesk/dsh-sandbox-local'],
      ['filesystem', '@panedesk/dsh-fs-local'],
      ['attachment-local', '@panedesk/dsh-attachment-local'],
      ['tool-fs', '@panedesk/dsh-tool-fs'],
      ['working-directory', '@panedesk/dsh-working-directory'],
      ['tool-working-directory', '@panedesk/dsh-tool-working-directory'],
      ['session-projection', '@panedesk/dsh-session-projection'],
      ['token-meter', '@panedesk/dsh-token-meter'],
      ['compaction-basic', '@panedesk/dsh-compaction-basic'],
      ['image-offload', '@panedesk/dsh-compaction-image-offload'],
      ['sandbox-policy', '@panedesk/dsh-sandbox-policy'],
      ['subprocess', '@panedesk/dsh-subprocess-local'],
      ['pty', '@panedesk/dsh-terminal'],
      ['terminal-bash', '@panedesk/dsh-terminal-bash'],
      ['terminal-pwsh', '@panedesk/dsh-terminal-bash'],
      ['timer', '@panedesk/cordis-plugin-timer'],
      ['llm', '@panedesk/dsh-llm'],
      ['session', '@panedesk/dsh-session'],
      ['session-title', '@panedesk/dsh-session-title'],
      ['system-prompt', '@panedesk/dsh-system-prompt'],
      ['tools', '@panedesk/dsh-tools'],
      ['mcp-resources', '@panedesk/dsh-mcp-resources'],
      ['agent', '@panedesk/dsh-agent'],
      ['llm-retry', '@panedesk/dsh-llm-retry'],
      ['jobs', '@panedesk/dsh-jobs-local'],
      ['agent-loop', '@panedesk/dsh-agent-loop'],
      ['persistent-bash', '@panedesk/dsh-tool-bash-persistent'],
      ['persistent-pwsh', '@panedesk/dsh-tool-pwsh-persistent'],
      ['sessions', '@panedesk/dsh-session-persistence-jsonl'],
    ])
    expect(rows.find(row => row.id === 'sdk-app-startup')?.config).toEqual({ profile: 'sdk-minimal' })
    expect(rows.find(row => row.id === 'sdk-jsonrpc-server')).toMatchObject({
      inject: ['sdkAppStartup', 'loader'],
      config: { maxTokensAsSuccess: false },
    })
    expect(rows.find(row => row.id === 'llm-deepseek')?.config).toEqual({
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultContextWindow: { __jsExpr: 'Number(process.env.DSH_CONTEXT_WINDOW ?? 1000000)' },
      streamIdleTimeoutMs: 172800000,
    })
    expect(rows.find(row => row.id === 'system-prompt')?.config).toEqual({
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      personaPrefix: { __jsExpr: "process.env.DSH_SYSTEM_PROMPT ?? 'You are a helpful software engineer assistant.'" },
    })
    expect(rows.find(row => row.id === 'agent-loop')?.config).toEqual({ agents: [] })
    expect(rows.find(row => row.id === 'tool-fs')?.config).toEqual({ read: false, readImage: true, write: false, edit: false })
    expect(rows.find(row => row.id === 'compaction-basic')?.config).toBeUndefined()
    expect(rows.find(row => row.id === 'terminal-bash')).toMatchObject({
      disabled: { __jsExpr: "process.platform === 'win32'" },
    })
    expect(rows.find(row => row.id === 'terminal-pwsh')).toMatchObject({
      disabled: { __jsExpr: "process.platform !== 'win32'" },
      config: { shellDialect: 'pwsh', timeoutMs: 300000 },
    })
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(
      [...new Set(rows.map(row => row.name).filter((name): name is string => name !== undefined).map(packageName))].sort(),
    )
  })
})
