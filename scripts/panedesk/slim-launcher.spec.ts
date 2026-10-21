/**
 * Panedesk fork check: the default launcher installation must not include experimental bundles.
 * Upstream permits launchers to carry these bundles directly, so this fork-owned test keeps
 * them in the full carrier without changing upstream checks.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OPTIONAL_BUNDLES } from '../../packages/boot/app-boot/src/profile.ts'

interface Manifest {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const launcher = JSON.parse(readFileSync(new URL('../../apps/cli/package.json', import.meta.url), 'utf8')) as Manifest
const full = JSON.parse(readFileSync(new URL('../../packages/bundle/full/package.json', import.meta.url), 'utf8')) as Manifest

function directBundleViolations(manifest: Manifest): string[] {
  const violations: string[] = []
  for (const name of OPTIONAL_BUNDLES) {
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      if (!Object.hasOwn(manifest[section] ?? {}, name)) continue
      if (section === 'peerDependencies' && manifest.peerDependenciesMeta?.[name]?.optional === true) continue
      violations.push(`panedesk ${section} must not carry ${name} directly; install it through @panedesk/full`)
    }
  }
  return violations
}

describe('Panedesk slim launcher', () => {
  it('keeps optional bundles out of the real launcher dependency declarations', () => {
    expect(OPTIONAL_BUNDLES.length).toBeGreaterThan(0)
    expect(directBundleViolations(launcher)).toEqual([])
  })

  it('declares the full carrier as an optional peer', () => {
    expect(launcher.peerDependencies).toHaveProperty('@panedesk/full')
    expect(launcher.peerDependenciesMeta?.['@panedesk/full']?.optional).toBe(true)
  })

  it('carries every optional bundle in the full carrier dependencies', () => {
    for (const name of OPTIONAL_BUNDLES) {
      expect(Object.hasOwn(full.dependencies ?? {}, name), `${name} must be a dependency of @panedesk/full`).toBe(true)
    }
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'] as const)(
    'rejects an optional bundle carried directly in %s and names the package',
    (section) => {
      const name = OPTIONAL_BUNDLES[0]!
      const manifest: Manifest = { [section]: { [name]: 'workspace:*' } }
      expect(directBundleViolations(manifest)).toEqual([
        `panedesk ${section} must not carry ${name} directly; install it through @panedesk/full`,
      ])
    },
  )

  it('allows an optional bundle declared only as an optional peer', () => {
    const name = OPTIONAL_BUNDLES[0]!
    expect(directBundleViolations({
      peerDependencies: { [name]: 'workspace:*' },
      peerDependenciesMeta: { [name]: { optional: true } },
    })).toEqual([])
  })
})
