import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { SeatImportPlan, SeatNodeId } from '@panedesk/dsh-seat'
import { deployment } from './fixtures/e2e-config.ts'

const bin = fileURLToPath(new URL('../../../../apps/cli/lib/bin.js', import.meta.url))
const homes: string[] = []
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }) })

async function fixture(enabled = false) {
  const home = await mkdtemp(join(tmpdir(), 'seat-cli-')); homes.push(home)
  const nodeId = '00000000-0000-4000-8000-000000000001' as SeatNodeId
  const config = deployment(home, nodeId)
  config.local.defaults.permissionPreset = 'workspace-write'
  await mkdir(join(home, 'ledger/v1'), { recursive: true })
  await writeFile(join(home, 'ledger/v1/node-id'), nodeId)
  const patch = join(home, 'deployment.patch.yml')
  await writeFile(patch, JSON.stringify([{ id: 'seat-local', config: config.local },
    ...enabled ? [{ id: 'seat-engine', disabled: false, config: config.engine }] : []]))
  const run = async (command: string, request?: object) => {
    const args = [bin, '--profile', 'seat', '--patch', patch, command,
      ...request ? ['--request', JSON.stringify(request)] : []]
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: home, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, PANEDESK_HOME: home,
          PANEDESK_TELEMETRY_DISABLED: '1', LANG: 'C.UTF-8', CI: 'true',
          ...process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {} } })
      let stdout = '', stderr = '', timedOut = false
      const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 60000)
      child.stdout.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
      child.once('error', (error) => { clearTimeout(timeout); reject(error) })
      child.once('close', (code) => {
        clearTimeout(timeout)
        if (timedOut) reject(new Error(`Seat CLI timed out. stdout: ${stdout}\nstderr: ${stderr}`))
        else resolve({ code, stdout, stderr })
      })
    })
  }
  return { home, run, nodeId }
}

function output(result: { code: number | null; stdout: string; stderr: string }, code = 0): unknown {
  expect(result.stderr).toBe('')
  expect(result.code).toBe(code)
  return JSON.parse(result.stdout.trim())
}

describe('seat built CLI across real processes', { retry: 0 }, () => {
  it('reports unavailable engine evidence without blocking node identity or catalog commands', async () => {
    const { run, nodeId } = await fixture()
    expect(output(await run('nodeStatus'))).toEqual({ nodeId, nodeName: 'node-a', engine: 'unavailable',
      openEngineWindows: 0, limit: null, readyAt: null })
    expect(output(await run('list'), 2)).toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
    expect(output(await run('pending'), 2)).toMatchObject({ status: 'rejected', error: { code: 'unavailable' } })
  })

  it('commits a preview in another process and rejects changed source bytes and catalog revisions', async () => {
    const { home, run } = await fixture()
    const sourcePath = join(home, 'source.csv')
    await writeFile(sourcePath, 'seat\nseat-a\n')
    const request = { format: 'csv', sourcePath, columnMap: { seat: 'seat' }, defaults: {} }
    const preview = async () => {
      const plan = output(await run('import.preview', request)) as SeatImportPlan
      expect(plan.planId).toMatch(/^[a-f0-9-]{36}$/)
      expect(Number.isSafeInteger(plan.baseRevision)).toBe(true)
      expect(plan.sourceFileHash).toMatch(/^[a-f0-9]{64}$/)
      expect(plan.rows[0]?.selected).toBe(true)
      return plan
    }
    const first = await preview(), obsolete = await preview()
    const commit = (plan: typeof first, operationId: string) => run('import.commit', {
      planId: plan.planId, selectedRows: [2], expectedRevision: plan.baseRevision, operationId,
    })
    expect(output(await commit(first, 'operation-a'))).toMatchObject({ status: 'committed', revision: 1 })
    expect(await readFile(join(home, 'storages/seat_catalog.json'), 'utf8')).toContain('seat-a')
    expect(output(await commit(first, 'operation-a'))).toMatchObject({ status: 'committed', revision: 1 })
    expect(output(await commit(obsolete, 'operation-b'), 2)).toMatchObject({ error: { code: 'import-preview-stale' } })
    const changed = await preview()
    await writeFile(sourcePath, 'seat\nseat-b\n')
    expect(output(await commit(changed, 'operation-c'), 2)).toMatchObject({ error: { code: 'import-preview-stale' } })
  })

  it('waits for an enabled engine and lists its real window evidence', async () => {
    const { run, nodeId } = await fixture(true)
    expect(output(await run('nodeStatus'))).toMatchObject({ nodeId, nodeName: 'node-a', engine: 'running', openEngineWindows: 0 })
    expect(output(await run('list'))).toMatchObject({ status: 'listed', sessions: [], unopenedSeats: [], complete: true })
  })
})
