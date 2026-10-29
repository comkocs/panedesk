/** Startup and recovery reports never serialize credential-bearing exception text. */
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { reportHostFailure } from '../src/failure-log.ts'

it.each(['startup', 'recovery'] as const)('writes one %s error to stderr and the home log', async (phase) => {
  const home = await mkdtemp(join(process.cwd(), '.failure-log-'))
  const stderr: string[] = []
  try {
    const error = Object.assign(new Error('password=private-value https://user:private-value@example.invalid/path\nextra'), { code: 'EACCES' })
    const line = reportHostFailure(phase, error, { home, stderr: (value) => { stderr.push(value) } })
    expect(stderr).toEqual([line])
    expect(line).toBe(`error host-${phase}-EACCES: Host ${phase} failed; inspect the configured service and durable state.\n`)
    expect(await readFile(join(home, '.panedesk', 'logs', 'host-errors.log'), 'utf8')).toBe(line)
    expect(line).not.toMatch(/private-value|https:|password|extra/)
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('rejects arbitrary machine codes and retains append-only records when stderr fails', async () => {
  const home = await mkdtemp(join(process.cwd(), '.failure-log-'))
  try {
    const error = Object.assign(new Error('Synthetic failure'), { code: 'secret-value\ninjected' })
    const first = reportHostFailure('startup', error, { home, stderr: () => { throw new Error('Sink unavailable') } })
    const second = reportHostFailure('recovery', error, { home, stderr: () => {} })
    expect(first).toContain('host-startup-failure:')
    expect(first + second).not.toContain('secret-value')
    expect(await readFile(join(home, '.panedesk', 'logs', 'host-errors.log'), 'utf8')).toBe(first + second)
  } finally { await rm(home, { recursive: true, force: true }) }
})

it.skipIf(process.platform === 'win32')('rejects linked and non-private existing log files without altering their contents', async () => {
  const home = await mkdtemp(join(process.cwd(), '.failure-log-'))
  const stderr: string[] = []
  const path = join(home, '.panedesk', 'logs', 'host-errors.log')
  try {
    await mkdir(join(home, '.panedesk', 'logs'), { recursive: true, mode: 0o700 })
    const target = join(home, 'untouched')
    await writeFile(target, 'original', { mode: 0o600 })
    await symlink(target, path)
    reportHostFailure('startup', new Error('Synthetic failure'), { home, stderr: (line) => { stderr.push(line) } })
    expect(stderr.at(-1)).toContain('host-log-unavailable:')
    expect(await readFile(target, 'utf8')).toBe('original')
    await rm(path)
    await writeFile(path, 'original', { mode: 0o600 })
    await chmod(path, 0o644)
    reportHostFailure('recovery', new Error('Synthetic failure'), { home, stderr: (line) => { stderr.push(line) } })
    expect(stderr.at(-1)).toContain('host-log-unavailable:')
    expect(await readFile(path, 'utf8')).toBe('original')
  } finally { await rm(home, { recursive: true, force: true }) }
})
