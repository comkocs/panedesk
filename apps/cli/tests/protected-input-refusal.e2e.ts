/** The shipped CLI exposes a refused protected input and exits without a model turn. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleLaunch } from '@panedesk/dsh-loader-smoke'

it('shows bilingual protected-input recovery instructions and exits nonzero through the CLI', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cli-protected-input-refusal-'))
  try {
    const home = join(cwd, '.panedesk')
    const profileDir = join(home, 'profiles/headless')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-headless', private: true, dependencies: {},
      dsh: { profile: { bundles: ['@panedesk/dsh-base', '@panedesk/dsh-headless'] } },
    }))
    const fixture = pathToFileURL(fileURLToPath(new URL('./fixtures/refused-protected-input.mjs', import.meta.url))).href
    await writeFile(join(profileDir, 'cordis.patch.yml'), `- insert:\n    - id: refused-protected-input\n      name: '${fixture}'\n`)
    const launch = resolveExampleLaunch({
      srcBin: fileURLToPath(new URL('../src/bin.ts', import.meta.url)),
      configArgs: ['--profile', 'headless', '--json', 'must not dispatch'],
      tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
      env: { HOME: cwd, PANEDESK_HOME: home, PANEDESK_AGENTS_HOME: join(cwd, '.agents'), PANEDESK_TELEMETRY_DISABLED: '1' },
    })
    const result = await execa(launch.command, launch.args, {
      cwd, env: launch.env, stdin: 'ignore', reject: false,
      timeout: LOADER_SMOKE_TEST_TIMEOUT_MS, killSignal: 'SIGKILL',
    })
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(1)
    for (const output of [result.stdout, result.stderr]) {
      expect(output).toContain('Protected host input requires owner confirmation before creating an agent')
      expect(output).toContain('受保护宿主输入复核未通过，无法创建代理。')
      expect(output).toContain('Explicitly authorize workspace write access again')
      expect(output).toContain('请重新显式授权该工作区写入一次')
    }
  } finally { await rm(cwd, { recursive: true, force: true }) }
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
