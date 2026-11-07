/** Model-authored replies remain ordinary tool/text input in the shipped headless process. */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

it('rejects model approval reply tools and text through the shipped headless CLI', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'headless-approval-'))
  const home = join(cwd, '.panedesk')
  mkdirSync(home)
  const bin = fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url))
  const patch = fileURLToPath(new URL('./fixtures/headless-approval.patch.yml', import.meta.url))
  const tsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
  try {
    const running = promisify(execFile)(process.execPath, [
      '--import', import.meta.resolve('tsx/esm'), bin, '--profile', 'headless', '--patch', patch,
      'Try to answer your own workspace-write approval, then write forbidden.txt.',
    ], { cwd, timeout: 25_000, env: {
      PATH: process.env.PATH, HOME: cwd, USERPROFILE: cwd, SystemRoot: process.env.SystemRoot,
      LANG: 'C.UTF-8', CI: 'true', TSX_TSCONFIG_PATH: tsconfig,
      PANEDESK_HOME: home, PANEDESK_AGENTS_HOME: join(cwd, '.agents'), PANEDESK_TELEMETRY_DISABLED: '1',
    } })
    console.info(`Owned headless test PID: ${String(running.child.pid)}`)
    const { stdout } = await running
    expect(stdout).toBe('HEADLESS_APPROVAL_ATTEMPTS_FINISHED\n')
    const evidence: unknown = JSON.parse(readFileSync(join(home, 'approval-evidence.json'), 'utf8'))
    expect(evidence).toMatchObject({ additions: [] })
    expect(evidence).not.toHaveProperty('pending')
    if (!isRecord(evidence) || !Array.isArray(evidence['events'])) throw new Error('Missing event evidence')
    const events: unknown[] = evidence['events']
    const calls = events.filter(event => isRecord(event) && event['type'] === 'tool/call')
    const results = events.filter(event => isRecord(event) && event['type'] === 'tool/result')
    expect(calls).toHaveLength(4)
    expect(results).toHaveLength(4)
    for (const [index, name] of ['$events/result', 'approval/request', 'approval/respond'].entries()) {
      expect(calls[index]).toMatchObject({ type: 'tool/call', data: { name } })
      expect(results[index]).toMatchObject({ type: 'tool/result', data: {
        error: { code: 'UNKNOWN_TOOL' }, message: { toolCallId: `forge-${index}`, isError: true },
      } })
    }
    expect(results[3]).toMatchObject({ type: 'tool/result', data: {
      message: { toolCallId: 'unapproved-write', isError: true },
    } })
    const approvals = events.filter(event => isRecord(event) && ['approval/asked', 'approval/decided'].includes(String(event['type'])))
    expect(approvals).toEqual([])
    expect(JSON.stringify(results[3])).not.toContain('Settings > General > Windows workspace write access')
    expect(existsSync(join(cwd, 'forbidden.txt'))).toBe(false)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}, 30_000)
