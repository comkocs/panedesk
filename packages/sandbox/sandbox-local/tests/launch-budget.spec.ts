/** Crowded private-path ancestors fail before launching or changing grants. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { en, zh } from '../src/launch-budget-locales.ts'
import { landlockProfileArgs } from '../src/profiles.ts'

afterEach(() => {
  vi.doUnmock('koffi')
  vi.resetModules()
})

it('names the crowded ancestor and entry count in both refusal languages', () => {
  const root = mkdtempSync(join(tmpdir(), 'launch-budget-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const owner = join(root, 'private')
  mkdirSync(owner)
  for (let index = 0; index < 8_000; index++) {
    writeFileSync(join(root, `${index}-${'s'.repeat(220)}`), '')
  }
  let failure: unknown
  try {
    landlockProfileArgs({ mode: 'read-only', workspaceRoot: root, unreadablePaths: [owner] })
  } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(Error)
  const message = (failure as Error).message
  expect(message).toContain(`ancestor directory ${JSON.stringify(root)} contains 8001 entries`)
  expect(message).toContain(`祖先目录 ${JSON.stringify(root)} 含 8001 项`)
  expect(message).toContain('Remove expired temporary entries')
  expect(message).toContain('将工作区与私密路径移出拥挤目录')
})

it.skipIf(process.platform !== 'linux')('refuses 32000 real sibling entries before native launch and names their ancestor', () => {
  const root = mkdtempSync(join(tmpdir(), 'launch-scale-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const owner = join(root, 'private')
  mkdirSync(owner)
  for (let index = 0; index < 32_000; index++) {
    writeFileSync(join(root, `${index}-${'s'.repeat(64)}`), '')
  }
  expect(() => landlockProfileArgs(
    { mode: 'read-only', workspaceRoot: root, unreadablePaths: [owner] },
    { file: '/synthetic/landlock-run', argv: ['/bin/true'] },
  )).toThrow(`${en.crowdedAncestor(root, 32_001)} / ${zh.crowdedAncestor(root, 32_001)}`)
})

it('refuses Landlock grants when the synchronous heap is missing', async () => {
  vi.resetModules()
  vi.doMock('koffi', () => ({ default: { config: () => ({}) } }))
  const { landlockProfileArgs: profile } = await import('../src/profiles.ts')
  expect(() => profile({ mode: 'read-only', workspaceRoot: '/workspace' })).toThrow('execve argument budget unavailable')
  expect(() => profile({ mode: 'read-only', workspaceRoot: '/workspace' })).toThrow('参数预算不可用')
})
