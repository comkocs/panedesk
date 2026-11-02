/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@panedesk/cordis-plugin-include'
import { evaluate } from '@panedesk/cordis-plugin-loader'

describe('dsh-base bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    // The base layer is one insert list over the empty profile root.
    const rows = (parsed as { insert?: { id?: string; config?: Record<string, unknown>; disabled?: boolean }[] }[]).flatMap(
      patch => patch.insert ?? [],
    )
    expect(rows.length).toBeGreaterThan(50)
    expect(rows.some(row => row.id === 'agent-loop')).toBe(true)
    expect(rows.find(row => row.id === 'session-telemetry-otel')?.disabled).toBeUndefined()
    expect(rows.find(row => row.id === 'session-telemetry-otel')?.config?.['mode']).toEqual({
      __jsExpr: "process.env.PANEDESK_TELEMETRY_MODE || 'DISABLED'",
    })
    expect(rows.find(row => row.id === 'hmr')).toMatchObject({
      config: { root: [] },
    })
    expect(rows.filter(row => row.id === 'subagent-codex')).toHaveLength(0)
    expect(rows.filter(row => row.id === 'subagent-claude-code')).toHaveLength(0)
    expect(rows.find(row => row.id === 'web')?.config).toMatchObject({ fetchProvider: 'http' })
    expect(rows.find(row => row.id === 'web-fetch-http')).toBeDefined()
    expect(rows.find(row => row.id === 'tool-web')?.config).toMatchObject({ fetch: true })
    expect(rows.find(row => row.id === 'jobs')?.config).toMatchObject({ reportPathsInNotifications: true })
    expect(rows.find(row => row.id === 'subagent')?.config).toMatchObject({ reportPathsInNotifications: true })
    expect(rows.find(row => row.id === 'agent-instructions')?.config).toMatchObject({
      includeSessionWorkspaceRoots: true, refreshIntervalMs: 5000,
    })
    expect(manifest.dependencies).not.toHaveProperty('@panedesk/dsh-subagent-codex')
    expect(manifest.dependencies).not.toHaveProperty('@panedesk/dsh-subagent-claude-code')
    expect(manifest.dependencies).toHaveProperty('@panedesk/dsh-web-fetch-http')
  })

  it('gates each shell stack by platform with a symmetric disabled expression', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const parsed = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(parsed)) throw new TypeError('base patch must parse to a patch list')
    const rows = parsed.flatMap((patch): Record<string, unknown>[] =>
      typeof patch === 'object' && patch !== null
        ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
        : [],
    )
    // Symmetric gating: each stack's executor and tool rows carry the same
    // platform fact, inverted between the bash and pwsh twins, so exactly one
    // shell stack mounts per host. Evaluate with a platform-scoped context
    // (the `with` scope shadows the global `process` and `ctx`) so both
    // outcomes pin on every host; the windowsBashConfig product selection and
    // the PANEDESK_BASH_PATH override are two independent enable paths.
    const scope = (platform: NodeJS.Platform, env: Record<string, string>, windowsBashConfig?: { enabled: boolean; bashPath: string }) => ({
      process: { platform, env },
      ctx: { get: (name: string) => (name === 'windowsBashConfig' ? () => windowsBashConfig : undefined) },
    })
    for (const [id, win32, linux] of [
      ['bash-sandbox', true, false],
      ['tool-bash', true, false],
      ['pwsh-sandbox', false, true],
      ['tool-pwsh', false, true],
    ] as const) {
      const row = rows.find(candidate => candidate.id === id)
      if (row === undefined) throw new Error(`base patch must mount ${id}`)
      const expression = (row.disabled as { __jsExpr?: string } | undefined)?.__jsExpr
      if (expression === undefined) throw new Error(`${id} must gate on a !!js disabled expression`)
      expect(Boolean(evaluate(scope('win32', {}), expression)), `${id} on win32`).toBe(win32)
      expect(Boolean(evaluate(scope('linux', {}), expression)), `${id} on linux`).toBe(linux)
    }
    const policyConfig = rows.find(row => row.id === 'sandbox-policy')?.config as { mode: { __jsExpr: string } }
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      expect(evaluate(scope(platform, {}), policyConfig.mode.__jsExpr)).toBeUndefined()
      expect(evaluate(scope(platform, { PANEDESK_PERMISSION_MODE: 'read-only' }), policyConfig.mode.__jsExpr)).toBe('read-only')
    }
    const bashPath = 'C:\\Program Files\\Git\\bin\\bash.exe'
    for (const id of ['bash-sandbox', 'tool-bash', 'pwsh-sandbox', 'tool-pwsh']) {
      const row = rows.find(candidate => candidate.id === id)!
      const expression = (row.disabled as { __jsExpr: string }).__jsExpr
      const pwsh = id.startsWith('pwsh') || id === 'tool-pwsh'
      expect(Boolean(evaluate(scope('win32', { PANEDESK_BASH_PATH: bashPath }), expression)), `${id} env override`).toBe(pwsh)
      expect(Boolean(evaluate(scope('win32', {}, { enabled: true, bashPath }), expression)), `${id} product config`).toBe(pwsh)
      // A selection the reader rejects (disabled, no path) keeps the default.
      expect(Boolean(evaluate(scope('win32', {}, { enabled: false, bashPath: '' }), expression)), `${id} inert config`).toBe(!pwsh)
    }
    const config = rows.find(row => row.id === 'bash-sandbox')?.config as { bashPath: { __jsExpr: string } }
    expect(evaluate(scope('linux', {}), config.bashPath.__jsExpr)).toBe('bash')
    expect(evaluate(scope('linux', { PANEDESK_BASH_PATH: bashPath }), config.bashPath.__jsExpr)).toBe(bashPath)
    expect(evaluate(scope('win32', {}, { enabled: true, bashPath }), config.bashPath.__jsExpr)).toBe(bashPath)
    // The platform layer folded into these rows: no separate patch file ships.
    expect(existsSync(resolve(root, 'windows.cordis.patch.yml'))).toBe(false)
  })
})
