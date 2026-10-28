import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@panedesk/cordis'
import { boot } from '@panedesk/dsh-app-boot'
import { provideCmdline } from '@panedesk/dsh-cmdline'
import LedgerQuery from '@panedesk/dsh-ledger-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as App from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function profile(ctx: Context, home: string, name: string): void {
  ctx.provide('profileContext', { name, home, cwd: home, dir: home,
    patchPath: join(home, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
    startedBundles: [name === 'ledger' ? '@panedesk/dsh-ledger-app' : '@panedesk/slim-base'],
    overlays: [], telemetryDisabledEnv: undefined })
}

async function failedMain(id: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'kernel-query-'))
  roots.push(home)
  const path = join(home, 'main.yml')
  await writeFile(path, JSON.stringify([{ id, name: './missing.mjs' }]))
  const ctx = await boot('kernel-main-test', path, undefined, (host) => { profile(host, home, 'slim') })
  contexts.push(ctx)
  return home
}

async function query(home: string, queryRow = { id: 'ledger-query', name: 'cordis:query', disabled: false }) {
  const path = join(home, 'query.yml')
  await writeFile(path, JSON.stringify([queryRow, { id: 'ledger-app', name: 'cordis:app' }]))
  const exit = vi.fn<(code: number) => void>()
  let ready: (() => void) | undefined
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  const ctx = await boot('kernel-query-test', path, undefined, (host) => {
    profile(host, home, 'ledger')
    host.loader.builtins.app = App
    host.loader.builtins.query = LedgerQuery
    provideCmdline(host, { args: ['today'], exit, ready: { onReady(callback) {
      ready = callback
      return () => { ready = undefined }
    } } })
  })
  contexts.push(ctx)
  ready!()
  await vi.waitFor(() => { expect(exit).toHaveBeenCalledTimes(1) })
  return { exit, stdout, stderr }
}

describe('cross-process kernel diagnostics', () => {
  it.each([
    ['session-ledger-full', 'sessionLedger'], ['llm-cache', 'llmCache'],
  ])('reports a failed %s before JSON without replacing main-process evidence', async (id, service) => {
    const home = await failedMain(id)
    const before = await readFile(join(home, 'run/kernel-status.json'), 'utf8')
    const marker = await readFile(join(home, 'run/kernel-boot.json'), 'utf8')
    const { exit, stdout, stderr } = await query(home)
    expect(exit).toHaveBeenCalledWith(0)
    expect(stderr.mock.calls).toHaveLength(1)
    expect(String(stderr.mock.calls[0]![0])).toContain(`Session ledger not mounted: ${service === 'llmCache' ? 'sessionLedger=missing(entry-missing); ' : ''}${service}=failed(import-failed:ERR_MODULE_NOT_FOUND)`)
    expect(String(stderr.mock.calls[0]![0])).not.toContain('may be stale')
    expect(JSON.parse(String(stdout.mock.calls[0]![0]))).toMatchObject({ complete: false })
    expect(await readFile(join(home, 'run/kernel-status.json'), 'utf8')).toBe(before)
    expect(await readFile(join(home, 'run/kernel-boot.json'), 'utf8')).toBe(marker)
  })

  it('marks an observation older than the latest boot as possibly stale', async () => {
    const home = await failedMain('session-ledger-full')
    await writeFile(join(home, 'run/kernel-boot.json'), JSON.stringify({ pid: process.pid, time: '9999-01-01T00:00:00.000Z' }))
    const { stderr } = await query(home)
    expect(String(stderr.mock.calls[0]![0])).toMatch(/^Session ledger not mounted: .* \(may be stale\)\n$/)
  })

  it('reports its own disabled query service and exits without JSON', async () => {
    const home = await failedMain('llm-cache')
    const { exit, stdout, stderr } = await query(home, { id: 'ledger-query', name: 'cordis:query', disabled: true })
    expect(exit).toHaveBeenCalledWith(1)
    expect(stdout).not.toHaveBeenCalled()
    expect(stderr.mock.calls.map(call => String(call[0]))).toContain('Session ledger not mounted: ledgerQuery=disabled(entry-disabled)\n')
  })
})
