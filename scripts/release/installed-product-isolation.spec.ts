/** Installed-product isolation uses resolved package identities and runtime edges. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS } from '../experimental-package-policy.ts'
import { verifyInstalledProductIsolation } from './installed-product-isolation.ts'

const roots: string[] = []
const experimental = '@panedesk/dsh-experimental-example'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-installed-isolation-'))
  roots.push(root)
  return root
}

function writePackage(root: string, key: string, manifest: Record<string, unknown>): string {
  const directory = join(root, 'node_modules', key)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ name: key, ...manifest })}\n`)
  return directory
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.each([experimental, ...Object.values(EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS)])('installed default-product isolation: %s', (experimental) => {
  it('ignores development dependencies and unrelated installed experimental packages', () => {
    const root = fixture()
    const entry = writePackage(root, 'panedesk', {
      dependencies: { core: '1.0.0' },
      devDependencies: { [experimental]: '1.0.0' },
    })
    writePackage(root, 'core', { peerDependencies: { 'panedesk': '1.0.0' } })
    writePackage(root, experimental, {})

    expect(verifyInstalledProductIsolation(entry)).toBe(2)
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'])(
    'rejects a transitive experimental %s',
    (section) => {
      const root = fixture()
      const entry = writePackage(root, 'panedesk', { dependencies: { thirdParty: '1.0.0' } })
      writePackage(root, 'thirdParty', { [section]: { [experimental]: '1.0.0' } })

      expect(() => verifyInstalledProductIsolation(entry)).toThrow(
        `panedesk -> thirdParty -> ${experimental}`,
      )
    },
  )

  it('skips the entry package\'s optional bundles, which must be installed, and still rejects other experimental edges', () => {
    const root = fixture()
    const entry = writePackage(root, 'panedesk', { dependencies: { core: '1.0.0', [experimental]: '1.0.0' } })
    writePackage(root, 'core', {})
    writePackage(root, experimental, { dependencies: { '@panedesk/dsh-experimental-inner': '1.0.0' } })
    expect(verifyInstalledProductIsolation(entry, [experimental])).toBe(2)

    writePackage(root, 'core', { dependencies: { [experimental]: '1.0.0' } })
    expect(() => verifyInstalledProductIsolation(entry, [experimental])).toThrow(`core -> ${experimental}`)

    const missing = writePackage(root, '@panedesk/dsh-missing', { dependencies: { absent: '1.0.0' } })
    expect(() => verifyInstalledProductIsolation(missing, ['absent'])).toThrow('optional bundle is missing: @panedesk/dsh-missing -> absent')
  })

  it('rejects experimental identities hidden behind an installed alias', () => {
    const root = fixture()
    const entry = writePackage(root, 'panedesk', { dependencies: { safeName: 'file:../prototype' } })
    writePackage(root, 'safeName', { name: experimental })

    expect(() => verifyInstalledProductIsolation(entry)).toThrow(experimental)
  })

  it('rejects experimental npm aliases even when an optional package is omitted', () => {
    const root = fixture()
    const entry = writePackage(root, 'panedesk', {
      optionalDependencies: { safeName: `npm:${experimental}@1.0.0` },
    })

    expect(() => verifyInstalledProductIsolation(entry)).toThrow(experimental)
  })

  it('follows nested installations rather than an unrelated hoisted package', () => {
    const root = fixture()
    const entry = writePackage(root, 'panedesk', { dependencies: { core: '1.0.0' } })
    writePackage(root, 'core', {})
    writePackage(entry, 'core', { dependencies: { [experimental]: '1.0.0' } })

    expect(() => verifyInstalledProductIsolation(entry)).toThrow(experimental)
  })

  it('admits optional bundles carried through the launcher\'s optional peer to the declared carrier and still rejects the rest', () => {
    const root = fixture()
    const entry = writePackage(root, 'panedesk', {
      peerDependencies: { '@panedesk/full': '1.0.0' },
      peerDependenciesMeta: { '@panedesk/full': { optional: true } },
    })
    writePackage(root, '@panedesk/full', { dependencies: { [experimental]: '1.0.0' } })
    writePackage(root, experimental, {})
    expect(verifyInstalledProductIsolation(entry, [experimental])).toBe(2)

    writePackage(root, 'panedesk', { dependencies: { core: '1.0.0' } })
    writePackage(root, 'core', {
      peerDependencies: { '@panedesk/full': '1.0.0' },
      peerDependenciesMeta: { '@panedesk/full': { optional: true } },
    })
    expect(() => verifyInstalledProductIsolation(entry, [experimental])).toThrow(`@panedesk/full -> ${experimental}`)

    const unlisted = '@panedesk/dsh-experimental-unlisted'
    writePackage(root, unlisted, {})
    writePackage(root, 'panedesk', { dependencies: { [unlisted]: '1.0.0' } })
    expect(() => verifyInstalledProductIsolation(entry, [experimental])).toThrow(`panedesk -> ${unlisted}`)

    writePackage(root, 'panedesk', {
      peerDependencies: { '@panedesk/full': '1.0.0' },
      peerDependenciesMeta: { '@panedesk/full': { optional: false } },
    })
    expect(() => verifyInstalledProductIsolation(entry, [experimental])).toThrow(`@panedesk/full -> ${experimental}`)

    writePackage(root, 'panedesk', {
      peerDependencies: { '@panedesk/full': '1.0.0' },
      peerDependenciesMeta: { '@panedesk/full': { optional: true } },
    })
    writePackage(root, '@panedesk/full', { dependencies: { '@panedesk/dsh-experimental-unlisted': '1.0.0' } })
    expect(() => verifyInstalledProductIsolation(entry, [experimental])).toThrow('@panedesk/dsh-experimental-unlisted')

    const absent = '@panedesk/dsh-experimental-example'
    writePackage(root, '@panedesk/full', { dependencies: { [absent]: '1.0.0' } })
    rmSync(join(root, 'node_modules', absent), { recursive: true, force: true })
    expect(() => verifyInstalledProductIsolation(entry, [absent])).toThrow(`optional bundle is missing: panedesk -> @panedesk/full -> ${absent}`)
  })

  it('permits missing optional packages and optional peers but rejects missing dependencies', () => {
    const root = fixture()
    const entry = writePackage(root, 'panedesk', {
      dependencies: { optional: '1.0.0' },
      optionalDependencies: { optional: '1.0.0' },
      peerDependencies: { peer: '1.0.0' },
      peerDependenciesMeta: { peer: { optional: true } },
    })
    expect(verifyInstalledProductIsolation(entry)).toBe(1)
    writePackage(root, 'panedesk', { dependencies: { missing: '1.0.0' } })
    expect(() => verifyInstalledProductIsolation(entry)).toThrow('dependency is missing')
  })
})
