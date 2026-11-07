/** Startup and recovery reports never serialize credential-bearing exception text. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { initProfile } from '@panedesk/dsh-app-boot'
import { reportHostFailure } from '../src/failure-log.ts'

it.each(['startup', 'recovery'] as const)('writes one %s error to stderr and the home log', async (phase) => {
  const home = await mkdtemp(join(process.cwd(), '.failure-log-'))
  const stderr: string[] = []
  try {
    const error = Object.assign(new Error('password=private-value https://user:private-value@example.invalid/path\nextra'), { code: 'EACCES' })
    const line = reportHostFailure(phase, error, { home, stderr: (value) => { stderr.push(value) } })
    expect(stderr).toEqual([line])
    expect(line).toBe(`error host-${phase}-EACCES: Host ${phase} failed; inspect the configured service and durable state.\n`)
    expect(await readFile(join(home, 'logs', 'host-errors.log'), 'utf8')).toBe(line)
    expect(line).not.toMatch(/private-value|https:|password|extra/)
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('resolves the log root through PANEDESK_HOME so concurrent instances write separately', async () => {
  const previous = process.env.PANEDESK_HOME
  const first = await mkdtemp(join(process.cwd(), '.failure-log-a-'))
  const second = await mkdtemp(join(process.cwd(), '.failure-log-b-'))
  try {
    process.env.PANEDESK_HOME = first
    reportHostFailure('startup', new Error('Synthetic failure'), { stderr: () => {} })
    process.env.PANEDESK_HOME = second
    reportHostFailure('startup', new Error('Synthetic failure'), { stderr: () => {} })
    expect(await readFile(join(first, 'logs', 'host-errors.log'), 'utf8')).toContain('host-startup-failure')
    expect(await readFile(join(second, 'logs', 'host-errors.log'), 'utf8')).toContain('host-startup-failure')
  } finally {
    if (previous === undefined) delete process.env.PANEDESK_HOME
    else process.env.PANEDESK_HOME = previous
    await Promise.all([first, second].map(path => rm(path, { recursive: true, force: true })))
  }
})

it('writes after a umask 0002 first start created the home chain owner-only', async () => {
  const previous = process.env.PANEDESK_HOME
  const home = await mkdtemp(join(process.cwd(), '.failure-log-umask-'))
  const umask = process.umask(0o002)
  try {
    process.env.PANEDESK_HOME = home
    initProfile(join(home, 'profiles', 'default'), [])
    const stderr: string[] = []
    reportHostFailure('startup', new Error('Synthetic failure'), { stderr: (value) => { stderr.push(value) } })
    expect(stderr).toHaveLength(1)
    expect(await readFile(join(home, 'logs', 'host-errors.log'), 'utf8')).toContain('host-startup-failure')
  } finally {
    process.umask(umask)
    if (previous === undefined) delete process.env.PANEDESK_HOME
    else process.env.PANEDESK_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

it('rejects arbitrary machine codes and retains append-only records when stderr fails', async () => {
  const home = await mkdtemp(join(process.cwd(), '.failure-log-'))
  try {
    const error = Object.assign(new Error('Synthetic failure'), { code: 'secret-value\ninjected' })
    const first = reportHostFailure('startup', error, { home, stderr: () => { throw new Error('Sink unavailable') } })
    const second = reportHostFailure('recovery', error, { home, stderr: () => {} })
    expect(first).toContain('host-startup-failure:')
    expect(first + second).not.toContain('secret-value')
    expect(await readFile(join(home, 'logs', 'host-errors.log'), 'utf8')).toBe(first + second)
  } finally { await rm(home, { recursive: true, force: true }) }
})
