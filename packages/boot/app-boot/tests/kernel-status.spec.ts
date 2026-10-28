import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@panedesk/cordis'
import { boot, type KernelStatus } from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function start(rows: string): Promise<{ ctx: Context; home: string; errors: readonly unknown[][] }> {
  const home = mkdtempSync(join(tmpdir(), 'kernel-status-'))
  roots.push(home)
  writeFileSync(join(home, 'cordis.yml'), rows)
  writeFileSync(join(home, 'mounted.mjs'), 'export function apply(ctx) { ctx.provide("sessionLedger", {}); ctx.provide("llmCache", {}) }\n')
  writeFileSync(join(home, 'waiting.mjs'), 'export const inject = ["missingDependency"]; export function apply() {}\n')
  writeFileSync(join(home, 'failure.mjs'), 'export function apply() { throw new Error("credential-bearing diagnostic") }\n')
  const errors: unknown[][] = []
  const ctx = await boot('kernel-test', join(home, 'cordis.yml'), undefined, (host) => {
    host.provide('profileContext', { name: 'slim', home, cwd: home, dir: home,
      patchPath: join(home, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
      startedBundles: ['@panedesk/slim-base'], overlays: [], telemetryDisabledEnv: undefined })
    host.logger.exporter({ levels: { default: 2 }, export: ({ type, args }) => {
      const values: readonly unknown[] = args
      if (type === 'error') errors.push([...values])
    } })
  })
  contexts.push(ctx)
  return { ctx, home, errors }
}

describe('kernel startup status', () => {
  it.each([
    ['session-ledger-full', 'sessionLedger', 'llmCache'],
    ['llm-cache', 'llmCache', 'sessionLedger'],
  ] as const)('reports a failed %s import once and atomically publishes safe status', async (id, service, sibling) => {
    const { ctx, home, errors } = await start(`- id: ${id}\n  name: ./missing.mjs\n`)
    const status = JSON.parse(readFileSync(join(home, 'run/kernel-status.json'), 'utf8')) as KernelStatus
    expect(status.services[service]).toEqual({ status: 'failed', cause: 'import-failed:ERR_MODULE_NOT_FOUND' })
    expect(status.services[sibling]).toEqual({ status: 'missing', cause: 'entry-missing' })
    const lines = errors.flat().filter(value => typeof value === 'string' && value.startsWith('Session ledger not mounted:'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`${service}=failed(import-failed:ERR_MODULE_NOT_FOUND)`)
    expect(lines[0]).not.toContain('\n')
    expect(ctx.get('kernelStatus')?.snapshot()).toEqual(status)
    expect(Object.isFrozen(ctx.get('kernelStatus')?.snapshot())).toBe(true)
  })

  it('distinguishes disabled and missing entries instead of treating them as mounted', async () => {
    const { home } = await start('- id: session-ledger-full\n  name: ./missing.mjs\n  disabled: true\n')
    const status = JSON.parse(readFileSync(join(home, 'run/kernel-status.json'), 'utf8')) as KernelStatus
    expect(status.services.sessionLedger).toEqual({ status: 'disabled', cause: 'entry-disabled' })
    expect(status.services.llmCache).toEqual({ status: 'missing', cause: 'entry-missing' })
  })

  it('publishes mounted services without a kernel error', async () => {
    const { home, errors } = await start('- id: mounted\n  name: ./mounted.mjs\n')
    const status = JSON.parse(readFileSync(join(home, 'run/kernel-status.json'), 'utf8')) as KernelStatus
    expect(Object.values(status.services)).toEqual([
      { status: 'mounted', cause: 'service-present' }, { status: 'mounted', cause: 'service-present' },
    ])
    expect(errors).toEqual([])
  })

  it('retains pending injection names but never arbitrary activation error text', async () => {
    const { home } = await start('- id: session-ledger-full\n  name: ./waiting.mjs\n- id: llm-cache\n  name: ./failure.mjs\n')
    const text = readFileSync(join(home, 'run/kernel-status.json'), 'utf8')
    const status = JSON.parse(text) as KernelStatus
    expect(status.services.sessionLedger).toEqual({ status: 'failed', cause: 'pending:missingDependency' })
    expect(status.services.llmCache).toEqual({ status: 'failed', cause: 'activation-failed' })
    expect(text).not.toContain('credential-bearing')
  })
})
