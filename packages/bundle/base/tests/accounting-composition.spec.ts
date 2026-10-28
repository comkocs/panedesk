import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyEntryPatches } from '@panedesk/cordis-plugin-include'
import { bundlePatchPaths, loadOverlayPatches, PROFILE_TEMPLATES } from '@panedesk/dsh-app-boot'
import { describe, expect, it } from 'vitest'

const bundles = fileURLToPath(new URL('../..', import.meta.url))

describe('accounting composition across surfaces', () => {
  it.each(['slim', 'full', 'web', 'desktop'])('%s retains independent message, accounting and cache entries without patch warnings', (surface) => {
    // Desktop initializes its project from the shipped Web template.
    const template = PROFILE_TEMPLATES[surface === 'desktop' ? 'web' : surface]!
    const warnings: string[] = []
    const patches = template.bundles.flatMap((name) => {
      const dir = join(bundles, name === '@panedesk/slim-base' ? 'slim-base'
        : name === '@panedesk/slim-headless' ? 'slim-headless' : name.replace('@panedesk/dsh-', ''))
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh: { bundle: { patch: string | string[] } } }
      return bundlePatchPaths(dir, manifest.dsh.bundle).flatMap(path => loadOverlayPatches('accounting-composition', path))
    })
    const rows = applyEntryPatches([], patches, line => warnings.push(line))
    expect(warnings).toEqual([])
    expect(new Set(rows.map(row => row.id)).size).toBe(rows.length)
    for (const [id, name] of [
      ['session-ledger', '@panedesk/dsh-session-ledger/messages'],
      ['session-ledger-full', '@panedesk/dsh-session-ledger'],
      ['llm-cache', '@panedesk/dsh-llm-cache'],
    ]) {
      expect(rows.filter(row => row.id === id)).toHaveLength(1)
      expect(rows.find(row => row.id === id)).toMatchObject({ name })
      expect(rows.find(row => row.id === id)?.disabled).toBeUndefined()
      expect(rows.find(row => row.id === id)?.config).toBeUndefined()
    }
  })
})
