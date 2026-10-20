/**
 * The slim one-shot bundle is a patch layer over @panedesk/slim-base: the
 * dsh-headless runner rows, the persona without the harness identity line, and
 * a default model row that deliberately names no route. Pin the patch against
 * the rows it composes onto.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { applyEntryPatches, entryListSchema } from '@panedesk/cordis-plugin-include'
import { evaluate } from '@panedesk/cordis-plugin-loader'

interface Row {
  id?: string
  name?: string
  inject?: string[]
  config?: Record<string, unknown>
  disabled?: unknown
  [key: string]: unknown
}

interface Patch extends Row {
  insert?: Row[]
}

interface Manifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

const root = fileURLToPath(new URL('..', import.meta.url))
const bundles = resolve(root, '..')

/** Parse one patch file through the Loader's own entry-list schema. */
function loadPatch(file: string): Patch[] {
  const parsed = yaml.load(readFileSync(file, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new TypeError(`${file} must parse to a patch list`)
  return parsed as Patch[]
}

const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest
const slimHeadless = loadPatch(resolve(root, manifest.dsh!.bundle!.patch!))
const slimBase = loadPatch(resolve(bundles, 'slim-base/cordis.patch.yml'))
const headless = loadPatch(resolve(bundles, 'headless/cordis.patch.yml'))

const insertedRows = (patches: Patch[]): Row[] => patches.flatMap(patch => patch.insert ?? [])
/** Patches that update a row by id (everything that is not an insert list). */
const updates = (patches: Patch[]): Patch[] => patches.filter(patch => patch.insert === undefined)

const slimBaseIds = new Set(insertedRows(slimBase).map(row => row.id))

/** Compose layers the way the boot include does: one patch application over the empty root. */
function compose(...layers: Patch[][]): { rows: Row[]; warnings: string[] } {
  const warnings: string[] = []
  const rows = applyEntryPatches([], structuredClone(layers.flat()) as never, (message: string) => {
    warnings.push(message)
  }) as Row[]
  return { rows, warnings }
}

describe('slim-headless bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(slimHeadless.length).toBeGreaterThan(0)
    expect(manifest.dependencies).toHaveProperty(['@panedesk/dsh-headless'])
  })

  it('turns the harness identity line off on the system-prompt row', () => {
    const systemPrompt = updates(slimHeadless).find(patch => patch.id === 'system-prompt')
    expect(systemPrompt?.config?.['includeHarnessIdentity']).toBe(false)
    expect(systemPrompt?.config?.['personaPrefix']).toEqual(expect.stringContaining('{{model}}'))
    const composed = compose(slimBase, slimHeadless).rows.find(row => row.id === 'system-prompt')
    expect(composed?.config?.['includeHarnessIdentity']).toBe(false)
  })

  it('inserts the headless startup provider and runner, identical to the dsh-headless rows', () => {
    const inserted = insertedRows(slimHeadless)
    expect(inserted.map(row => row.id)).toEqual(['headless-startup', 'headless-runner'])
    expect(inserted.find(row => row.id === 'headless-startup')?.name).toBe('@panedesk/dsh-headless/startup')
    expect(inserted.find(row => row.id === 'headless-runner')?.name).toBe('@panedesk/dsh-headless')
    const upstream = new Map(insertedRows(headless).map(row => [row.id, row]))
    for (const row of inserted) expect(row, `row ${String(row.id)}`).toEqual(upstream.get(row.id))
    // Same persona and tools-mode wiring as the upstream headless layer.
    for (const id of ['system-prompt', 'tools']) {
      const ours = updates(slimHeadless).find(patch => patch.id === id)
      const theirs = updates(headless).find(patch => patch.id === id)
      expect(ours, id).toBeDefined()
      expect(ours?.config?.['personaPrefix'], id).toEqual(theirs?.config?.['personaPrefix'])
      expect(ours?.config?.['mode'], id).toEqual(theirs?.config?.['mode'])
    }
  })

  it('only patches or disables rows that slim-base actually mounts', () => {
    const known = new Set([...slimBaseIds, ...insertedRows(slimHeadless).map(row => row.id)])
    for (const patch of updates(slimHeadless)) {
      expect(known.has(patch.id), `patch targets ${String(patch.id)}`).toBe(true)
    }
    // upstream disables hmr / credentials / authorization / deepseek-account; slim-base never mounts those rows.
    for (const patch of updates(slimHeadless).filter(candidate => candidate.disabled !== undefined)) {
      expect(slimBaseIds.has(patch.id), `disabled row ${String(patch.id)}`).toBe(true)
    }
    for (const id of ['hmr', 'credentials', 'authorization', 'deepseek-account']) {
      expect(updates(slimHeadless).some(patch => patch.id === id), id).toBe(false)
      expect(slimBaseIds.has(id), id).toBe(false)
    }
  })

  it('composes over slim-base without skipped patches', () => {
    const { rows, warnings } = compose(slimBase, slimHeadless)
    expect(warnings).toEqual([])
    expect(rows).toHaveLength(slimBaseIds.size + 2)
    const ids = rows.map(row => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.slice(-2)).toEqual(['headless-startup', 'headless-runner'])
    expect(rows.some(row => row.disabled === true)).toBe(false)
    expect(rows.find(row => row.id === 'headless-runner')?.inject).toEqual(['headlessStartup'])
  })

  it('names no default model route: the default-model row fails loud and points at examples/providers/', () => {
    // The slim preset ships no provider choice. The row exists, but its provider is a
    // !!js expression that throws when evaluated, so an unconfigured run fails with
    // guidance instead of sending a request to a route nobody chose.
    const patch = updates(slimHeadless).find(candidate => candidate.id === 'agent-default-model')
    expect(patch, 'agent-default-model patch row').toBeDefined()
    expect(patch?.config?.['model']).toBe('unconfigured')
    const expression = (patch?.config?.['provider'] as { __jsExpr?: string } | undefined)?.__jsExpr
    expect(typeof expression, 'provider must be a !!js expression').toBe('string')
    expect(expression).toContain('examples/providers/')
    expect(expression).toContain('--patch')
    expect(() => evaluate({}, expression!)).toThrow(/^no model route is configured for the slim preset/)

    // No llm-pi-ai patch row: slim-headless adds no providers (and so no keys) of its own.
    expect(slimHeadless.some(candidate => candidate.id === 'llm-pi-ai')).toBe(false)
    expect(insertedRows(slimHeadless).some(row => row.id === 'llm-pi-ai')).toBe(false)
  })

  it('leaves the pi-ai adapter dormant and the composed default-model provider unresolved', () => {
    const { rows, warnings } = compose(slimBase, slimHeadless)
    expect(warnings).toEqual([])
    const byId = new Map(rows.map(row => [row.id, row]))
    // slim-base still mounts the provider-neutral adapter, with no providers configured.
    expect(byId.get('llm-pi-ai')?.name).toBe('@panedesk/dsh-llm-pi-ai')
    expect(byId.get('llm-pi-ai')?.config?.['providers']).toBeUndefined()
    // The composed default-model row is the failing placeholder, never a DeepSeek route.
    const config = byId.get('agent-default-model')?.config
    expect(config?.['model']).toBe('unconfigured')
    expect(JSON.stringify(config)).not.toMatch(/deepseek-official|deepseek-flash|DEEPSEEK_API_KEY/)
    // The pi-ai row is the bare mount: no config, so no provider profile and no key reference.
    expect(rows.find(row => row.id === 'llm-pi-ai')).toEqual({ id: 'llm-pi-ai', name: '@panedesk/dsh-llm-pi-ai' })
  })
})
