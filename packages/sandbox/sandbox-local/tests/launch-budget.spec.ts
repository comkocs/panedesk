/** Crowded private-path ancestors fail before launching or changing grants. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { landlockProfileArgs } from '../src/profiles.ts'

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
