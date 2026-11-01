/** Release rehearsal rejects unsafe packed bytes without publishing them. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { c } from 'tar'
import { afterEach, expect, it } from 'vitest'
import { scanTarball, releaseCheckPlan, publishDryRunArgs, sanitizeOutput } from './release-check.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function fixture(files: Record<string, string>): Promise<string> {
  const base = process.env.PANEDESK_TEST_ROOT ?? tmpdir()
  const root = mkdtempSync(join(base, 'release-check-'))
  roots.push(root)
  mkdirSync(join(root, 'package'))
  writeFileSync(join(root, 'package/package.json'), JSON.stringify({ name: 'panedesk', version: '0.2.1-rc.2' }))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, 'package', name), text)
  const archive = join(root, 'fixture.tgz')
  await c({ gzip: true, file: archive, cwd: root }, ['package'])
  return archive
}

it('rejects an internal marker inserted into a temporary tarball', async () => {
  const marker = ['M', '8c', '-K', '6'].join('')
  const result = await scanTarball(await fixture({ 'index.js': `export const marker = ${JSON.stringify(marker)}` }))
  expect(result.counts.internal).toBe(1)
  expect(result.passed).toBe(false)
})

it('accepts a clean tarball and records identity, files, and byte sizes', async () => {
  const archive = await fixture({ 'index.js': 'export const value = 1\n' })
  const result = await scanTarball(archive)
  expect(result).toMatchObject({ name: 'panedesk', version: '0.2.1-rc.2', files: 2, passed: true })
  expect(result.bytes).toBe(readFileSync(archive).byteLength)
  expect(Object.values(result.counts).every(count => count === 0)).toBe(true)
})

it.each([
  ['privatePath', 'index.js', ['/', 'home', '/', 'private-user', '/', 'source'].join('')],
  ['token', 'index.js', ['gh', 'p_', 'x'.repeat(36)].join('')],
  ['fixtureKey', 'index.js', ['apiKey', ': ', '"test-', 'secret"'].join('')],
  ['credentials', '.env', 'SETTING=value'],
  ['credentials', 'id_rsa', 'sensitive material'],
] as const)('rejects %s in packed paths or contents', async (category, name, text) => {
  const result = await scanTarball(await fixture({ [name]: text }))
  expect(result.counts[category]).toBeGreaterThan(0)
  expect(result.passed).toBe(false)
})

it('keeps verification and packing upstream and pins dry-run to the public registry', () => {
  const plan = releaseCheckPlan('/owned/output', ['/owned/vendor'])
  expect(plan.map(step => step.args)).toEqual([
    ['run', 'release:verify', '--family', 'dsh'],
    ['run', 'release:pack', '--family', 'dsh', '--out', '/owned/output/tarballs'],
    ['run', 'release:verify-packed-install', '--family', 'dsh', '--from', '/owned/output/tarballs', '--from', '/owned/vendor'],
  ])
})

it('selects an explicit prerelease tag without permitting registry writes', () => {
  expect(publishDryRunArgs('/owned/package.tgz', '0.2.1-rc.2')).toEqual([
    'publish', '--dry-run', '--registry', 'https://registry.npmjs.org/', '--tag', 'next', '/owned/package.tgz',
  ])
  expect(publishDryRunArgs('/owned/package.tgz', '1.0.0')).toContain('latest')
})

it('redacts query strings and authentication headers before recording subprocess output', () => {
  expect(sanitizeOutput('https://example.test/path?secret=value Authorization: Bearer sensitive\nCookie: session=value'))
    .toBe('https://example.test/path?<redacted> Authorization: <redacted>\nCookie: <redacted>')
})
