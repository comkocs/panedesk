/**
 * The slim bundle's substance is its generated patch file: a verbatim row
 * subset of dsh-base. Pin that the patch parses, that every kept row is the
 * dsh-base row itself, and that no privacy-sensitive or DeepSeek-specific row
 * slipped in.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@panedesk/cordis-plugin-include'

interface Row {
  id?: string
  name?: string
  config?: Record<string, unknown>
  disabled?: unknown
  [key: string]: unknown
}

interface Manifest {
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

const root = fileURLToPath(new URL('..', import.meta.url))
const baseRoot = resolve(root, '../base')

/** Parse one patch file through the Loader's own entry-list schema. */
function loadPatch(file: string): unknown[] {
  const parsed = yaml.load(readFileSync(file, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new TypeError(`${file} must parse to a patch list`)
  return parsed
}

/** The rows of the single `insert` list a bundle patch carries over the empty profile root. */
function insertedRows(patches: unknown[]): Row[] {
  return patches.flatMap((patch): Row[] =>
    typeof patch === 'object' && patch !== null ? (patch as { insert?: Row[] }).insert ?? [] : [],
  )
}

/** Package a row mounts: the bare package of a possible subpath export. */
function packageOf(name: string): string {
  const parts = name.split('/')
  return parts[0]!.startsWith('@') ? `${parts[0]!}/${parts[1]!}` : parts[0]!
}

const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest
const slimRows = insertedRows(loadPatch(resolve(root, manifest.dsh!.bundle!.patch!)))
const baseRows = insertedRows(loadPatch(resolve(baseRoot, 'cordis.patch.yml')))

describe('slim-base bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = loadPatch(resolve(root, manifest.dsh!.bundle!.patch!))
    // One insert list over the empty profile root, exactly like dsh-base.
    expect(parsed).toHaveLength(1)
    expect(Object.keys(parsed[0] as object)).toEqual(['insert'])
    expect(slimRows.every(row => typeof row.id === 'string' && typeof row.name === 'string')).toBe(true)
  })

  it('mounts exactly the 42 slim rows with unique ids', () => {
    const ids = slimRows.map(row => row.id)
    expect(ids).toHaveLength(42)
    expect(new Set(ids).size).toBe(42)
    expect([...ids].sort()).toEqual([
      'llm', 'session', 'agent', 'agent-default-model', 'llm-retry', 'llm-pi-ai',
      'session-persistence-jsonl', 'working-directory', 'session-projection',
      'subprocess', 'sandbox', 'sandbox-policy', 'bash-sandbox', 'pwsh-sandbox',
      'approval', 'permission', 'shell-env', 'tool-bash', 'tool-pwsh',
      'fs-observation-policy', 'tool-fs', 'tool-fs-search',
      'subagent', 'subagent-spawn-in-process', 'tool-subagent',
      'session-checkpoint-policy', 'tools', 'system-prompt', 'agent-loop', 'fs-sandbox',
      'agent-instructions', 'token-meter', 'compaction-basic', 'timeout-policy',
      'spill-local', 'spill-policy', 'tool-result-pruner',
      'session-ledger', 'session-ledger-full', 'llm-cache', 'message-delivery', 'instruction-subscriptions',
    ].sort())
  })

  it('keeps every row deep-equal to the dsh-base row with the same id', () => {
    const baseById = new Map(baseRows.map(row => [row.id, row]))
    for (const row of slimRows) {
      const upstream = baseById.get(row.id)
      expect(upstream, `dsh-base must carry row ${String(row.id)}`).toBeDefined()
      expect(row, `row ${String(row.id)} must match dsh-base`).toEqual(upstream)
    }
  })

  it('keeps the dsh-base row order', () => {
    const baseOrder = baseRows.map(row => row.id)
    const positions = slimRows.map(row => baseOrder.indexOf(row.id))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('depends on exactly the packages its rows mount', () => {
    const dependencies = manifest.dependencies ?? {}
    const mounted = new Set(slimRows.map(row => packageOf(row.name!)))
    for (const row of slimRows) {
      expect(dependencies, `row ${String(row.id)} mounts ${row.name!}`).toHaveProperty([packageOf(row.name!)])
    }
    expect(new Set(Object.keys(dependencies))).toEqual(mounted)
    // Version specifiers come from dsh-base, so both bundles stay on one version of each plugin.
    const baseManifest = JSON.parse(readFileSync(resolve(baseRoot, 'package.json'), 'utf8')) as Manifest
    for (const [name, spec] of Object.entries(dependencies)) {
      expect(spec, name).toBe(baseManifest.dependencies?.[name])
    }
  })

  it('carries no privacy-sensitive or DeepSeek-specific row', () => {
    const forbidden = [
      'session-log-deepseek',
      'otel',
      'session-telemetry-otel',
      'llm-deepseek',
      'plugin-package-inventory-deepseek',
      'deepseek-llm-api-extensions',
      'deepseek-account',
      'credentials',
      'authorization',
      'api-gateway',
      'api-remote-access',
      'product-analytics',
    ]
    const dependencies = Object.keys(manifest.dependencies ?? {})
    for (const row of slimRows) {
      expect(forbidden, `row ${String(row.id)}`).not.toContain(row.id)
      expect(row.name, `row ${String(row.id)}`).not.toMatch(/-deepseek|otel|telemetry|analytics/)
    }
    for (const name of dependencies) {
      expect(name, 'dependency').not.toMatch(/-deepseek|otel|telemetry|analytics/)
    }
  })

  it('keeps the long-task rows: AGENTS.md, compaction, token meter, spill, and the timeout guard', () => {
    const ids = new Set(slimRows.map(row => row.id))
    for (const id of [
      'agent-instructions', 'compaction-basic', 'token-meter', 'tool-result-pruner',
      'spill-local', 'spill-policy', 'timeout-policy',
    ]) {
      expect(ids.has(id), `row ${id}`).toBe(true)
    }
    const dependencies = manifest.dependencies ?? {}
    for (const name of [
      '@panedesk/dsh-agent-instructions', '@panedesk/dsh-compaction-basic',
      '@panedesk/dsh-token-meter', '@panedesk/dsh-compaction-tool-result-pruner',
      '@panedesk/dsh-spill-local', '@panedesk/dsh-spill-policy',
      '@panedesk/dsh-tool-call-timeout-policy',
    ]) {
      expect(dependencies, name).toHaveProperty([name])
    }
  })

  it('gates each shell stack by platform on the copied rows, so exactly one mounts per host', () => {
    const byId = new Map(slimRows.map(row => [row.id, row]))
    for (const [id, win32] of [
      ['bash-sandbox', true], ['tool-bash', true], ['pwsh-sandbox', false], ['tool-pwsh', false],
    ] as const) {
      const expression = (byId.get(id)?.disabled as { __jsExpr?: string } | undefined)?.__jsExpr
      expect(expression, `${id} must gate on a !!js disabled expression`).toBeDefined()
      expect(expression).toContain(win32 ? "=== 'win32'" : "!== 'win32'")
    }
  })

  it('ships one patch file and no separate platform layer', () => {
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(existsSync(resolve(root, 'windows.cordis.patch.yml'))).toBe(false)
  })
})
