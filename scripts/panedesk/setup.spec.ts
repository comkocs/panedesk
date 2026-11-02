/** `pnpm run setup` plans one idempotent sequence, honors --link, and fails loudly per step. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { bootstrapDefaultProfile, plannedSetupSteps, runSetup, type SetupRunner } from './setup.ts'

const plan = (link: boolean): { label: string; command: string; args: readonly string[] }[] =>
  plannedSetupSteps({ link, bin: 'node', cliEntry: 'apps/cli/lib/bin.js' })

it('plans the frozen install, native addon, host libraries, CLI closure check, and profile bootstrap', () => {
  expect(plan(false)).toMatchObject([
    { label: 'frozen install', command: 'pnpm', args: ['install', '--frozen-lockfile'] },
    { label: 'native system addon', command: 'pnpm', args: ['run', 'build:native-system'] },
    { label: 'host libraries', command: 'pnpm', args: ['exec', 'tsx', 'scripts/compile-referenced-projects.ts', 'host-libraries'] },
    { label: 'CLI closure check', command: 'node', args: ['apps/cli/lib/bin.js', '--version'] },
    { label: 'default profile bootstrap', command: 'node', args: ['apps/cli/lib/bin.js', '--profile', 'slim', '--dump-default-config'] },
  ])
})

it('appends the global link step only with --link', () => {
  expect(plan(true).at(-1)).toMatchObject({ label: 'global link', command: 'pnpm', args: ['link', '--global'] })
  expect(plan(false).at(-1)!.label).toBe('default profile bootstrap')
})

it('produces an identical plan on the second run, so every step must be idempotent', () => {
  expect(plan(false)).toEqual(plan(false))
})

it('reports each failed step with a bilingual reason and next step', async () => {
  const written: string[] = []
  const failing: SetupRunner = {
    run: async (step) => { throw new Error(`${step.label} exploded`) },
  }
  const code = await runSetup({
    steps: plannedSetupSteps({ link: false, bin: 'node', cliEntry: 'apps/cli/lib/bin.js' }),
    io: { write: (text) => { written.push(text) } },
    runner: failing,
  })
  expect(code).toBe(1)
  const report = written.join('')
  expect(report).toContain('frozen install failed')
  expect(report).toContain('check the pnpm error above')
  expect(report).toMatch(/[一-鿿]/)
})

it('bootstraps the default profile without touching an initialized one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cli-setup-'))
  vi.stubEnv('PANEDESK_HOME', home)
  onTestFinished(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })
  const io = { write: (): void => {} }
  bootstrapDefaultProfile({ bin: process.execPath, cliEntry: 'apps/cli/lib/bin.js', io })
  const patch = join(home, 'profiles', 'slim', 'cordis.patch.yml')
  const first = readFileSync(patch, 'utf8')
  bootstrapDefaultProfile({ bin: process.execPath, cliEntry: 'apps/cli/lib/bin.js', io })
  expect(readFileSync(patch, 'utf8')).toBe(first)
})
