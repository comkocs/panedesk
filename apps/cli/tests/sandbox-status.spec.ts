/** Keyless sandbox diagnostics through the shipped source profile launcher. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProtectedInputIntegrity } from '@panedesk/dsh-app-boot'
import { execa } from 'execa'
import { expect, it, onTestFinished } from 'vitest'

const repo = fileURLToPath(new URL('../../../', import.meta.url))

it.each([true, false])('checks recorded host coverage before a CLI diagnostic can succeed: %s', { timeout: 90_000 }, async (covered) => {
  const root = mkdtempSync(join(tmpdir(), 'cli-sandbox-status-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const workspace = join(root, 'workspace')
  const home = join(root, 'owner')
  const profile = join(home, 'profiles', 'headless')
  mkdirSync(workspace)
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'sandbox-status-profile', private: true,
    dsh: { profile: { bundles: ['@panedesk/dsh-base', '@panedesk/dsh-headless'] } },
  }))
  const modelAttempt = join(root, 'model-attempt')
  const guard = join(root, 'no-model.mjs')
  writeFileSync(guard, `import { writeFileSync } from 'node:fs'
export function apply(ctx) {
  ctx.on('llm/stream', () => {
    writeFileSync(${JSON.stringify(modelAttempt)}, 'unexpected model request')
    throw new Error('Diagnostic must not request a model')
  })
}
`)
  writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([
    { id: 'sandbox', config: { runnerCommand: ['bwrap'], runnerFailureSignatures: ['sandbox fixture failure'] } },
    { insert: [{ id: 'no-model', name: guard }] },
  ]))
  const target = join(root, 'overlay.yml')
  const overlay = join(workspace, 'overlay.yml')
  writeFileSync(target, '[]\n')
  symlinkSync(target, overlay)
  if (covered) {
    const integrity = new ProtectedInputIntegrity(workspace, home)
    integrity.observe(overlay)
    integrity.grantWrite()
  }
  const result = await execa(process.execPath, [
    '--import', import.meta.resolve('tsx/esm'), join(repo, 'apps/cli/src/bin.ts'), '--profile', 'headless', '--patch', overlay,
    '--sandbox-status', 'zh', '--json',
  ], {
    cwd: workspace, input: '', timeout: 75_000, reject: false,
    env: {
      PANEDESK_HOME: home, PANEDESK_AGENTS_HOME: join(root, 'agents'), PANEDESK_TELEMETRY_DISABLED: '1',
      TSX_TSCONFIG_PATH: join(repo, 'tsconfig.json'), NODE_OPTIONS: undefined,
    },
  })
  const diagnostic = `${result.stdout}\n${result.stderr}`
  expect(result.timedOut, diagnostic).toBe(false)
  expect(result.exitCode, diagnostic).toBe(covered ? 0 : 1)
  if (covered) {
    const status: unknown = JSON.parse(result.stdout)
    expect(status).toMatchObject({
      type: 'sandbox-status', enforcement: 'full', message: '1 项由宿主兜底', hostFallbackCount: 1,
    })
    expect(status).toHaveProperty('protectedInputs', expect.arrayContaining([
      { path: overlay, enforcement: 'host-fallback', reason: 'link-name' },
    ]))
  } else expect(diagnostic).toContain('Protected host input has no fallback coverage')
  expect(diagnostic).not.toContain('"type":"session"')
  expect(existsSync(modelAttempt)).toBe(false)
})
