import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertDesktopHostPackageFiles,
  selectDesktopPackageClosure,
  type PackedDesktopPackage,
} from '../scripts/prepare-package-set.ts'

function packed(name: string, manifest: Record<string, unknown> = {}): PackedDesktopPackage {
  return { tarball: `${name}.tgz`, manifest: { name, version: '1.0.0', ...manifest } }
}

describe('desktop package-set selection', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not select a packaging target when imported as a library', async () => {
    vi.stubEnv('DSH_DESKTOP_TARGET_PLATFORM', 'linux')
    vi.stubEnv('DSH_DESKTOP_TARGET_ARCH', 'x64')
    vi.resetModules()
    await expect(import('../scripts/prepare-package-set.ts')).resolves.toHaveProperty('prepareDesktopPackageSet')
  })

  it('includes only the available internal production closure', () => {
    const available = new Map<string, PackedDesktopPackage>([
      ['panedesk', packed('panedesk', {
        dependencies: { '@panedesk/dsh-base': '^1.0.0', external: '^2.0.0' },
        optionalDependencies: { '@panedesk/platform-package': '1.0.0', '@panedesk/missing-platform': '1.0.0' },
      })],
      ['@panedesk/dsh-desktop-host', packed('@panedesk/dsh-desktop-host', {
        dependencies: { 'panedesk': '^1.0.0' },
      })],
      ['@panedesk/dsh-base', packed('@panedesk/dsh-base', {
        peerDependencies: { '@panedesk/cordis': '^1.0.0' },
      })],
      ['@panedesk/cordis', packed('@panedesk/cordis')],
      ['@panedesk/platform-package', packed('@panedesk/platform-package')],
      ['@panedesk/unused', packed('@panedesk/unused')],
    ])
    expect(selectDesktopPackageClosure(available).map(entry => entry.manifest.name)).toEqual([
      '@panedesk/cordis',
      'panedesk',
      '@panedesk/dsh-base',
      '@panedesk/dsh-desktop-host',
      '@panedesk/platform-package',
    ])
  })

  it.each([
    '@panedesk/dsh-base', '@panedesk/cordis', '@panedesk/node-addon-system',
  ])('rejects required prepared package %s absent from the packed release inputs', (dependency) => {
    const available = new Map<string, PackedDesktopPackage>([
      ['panedesk', packed('panedesk', {
        dependencies: { [dependency]: '^1.0.0' },
      })],
      ['@panedesk/dsh-desktop-host', packed('@panedesk/dsh-desktop-host', {
        dependencies: { 'panedesk': '^1.0.0' },
      })],
    ])
    expect(() => selectDesktopPackageClosure(available)).toThrow(/unpacked package/u)
    expect(() => selectDesktopPackageClosure(new Map([
      ['panedesk', packed('panedesk')],
    ]))).toThrow(/omit @panedesk\/dsh-desktop-host/u)
  })

  it('leaves independently published Office packages to npm resolution', () => {
    const available = new Map<string, PackedDesktopPackage>([
      ['panedesk', packed('panedesk', {
        dependencies: {
          '@deepseek-ai/libreoffice-kit': '0.0.1',
          '@deepseek-ai/libreoffice-kit-wasm': '0.0.1',
        },
      })],
      ['@panedesk/dsh-desktop-host', packed('@panedesk/dsh-desktop-host')],
    ])
    expect(selectDesktopPackageClosure(available).map(entry => entry.manifest.name)).toEqual([
      'panedesk', '@panedesk/dsh-desktop-host',
    ])
  })

  it('requires both Desktop Host and public CLI entries', () => {
    const files = [
      'package/lib/index.js',
      'package/lib/cli.js',
    ]
    expect(() => {
      assertDesktopHostPackageFiles(files)
    }).not.toThrow()
    expect(() => {
      assertDesktopHostPackageFiles(files.slice(1))
    }).toThrow(/lib\/index\.js/u)
    expect(() => { assertDesktopHostPackageFiles(files.slice(0, 1)) }).toThrow(/lib\/cli\.js/u)
  })
})
