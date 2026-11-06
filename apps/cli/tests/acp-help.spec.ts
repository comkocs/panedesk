/** `panedesk acp --help` prints help only: it starts no host, so its stderr carries no startup review. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { resolveExampleLaunch } from '@panedesk/dsh-loader-smoke'

/** The CLI source entry the shared example-launch resolver runs through tsx. */
const srcBin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

it('prints ACP help with an empty stderr and no startup review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cli-acp-help-'))
  try {
    const launch = resolveExampleLaunch({
      srcBin,
      configArgs: ['acp', '--help'],
      tsconfigPath,
      env: {
        HOME: root,
        PANEDESK_HOME: join(root, 'owner'),
        PANEDESK_AGENTS_HOME: join(root, 'agents'),
        PANEDESK_TELEMETRY_DISABLED: '1',
      },
    })
    const result = await execa(launch.command, launch.args, {
      cwd: root,
      env: { ...process.env, ...launch.env },
      stdin: 'ignore',
      reject: false,
      timeout: 60_000,
      killSignal: 'SIGKILL',
    })
    expect(result.exitCode, `acp --help failed. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('Usage: panedesk --profile acp')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 90_000)
