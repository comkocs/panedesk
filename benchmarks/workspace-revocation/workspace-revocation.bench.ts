/** Full-tree revocation costs include node_modules rather than pruning dependency trees. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runBuiltBenchmarkWorker } from '../support/built-worker.ts'
import { ciTimeBudget } from '../support/calibration.ts'
import { recordPeakMemory, recordTimings } from '../support/scaling-report.ts'
import type { WorkspaceRevocationReport } from './workspace-revocation.worker.ts'

const benchmarkCase = {
  id: 'workspace-revocation',
  measures: 'Production full-tree inventory of 100000 files in 1000 synthetic node_modules packages; native ACL calls are substituted.',
  affects: 'Revoking a workspace capability after restart without process-local grant history.',
}

it('measures a dependency-heavy workspace without excluding node_modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-revocation-bench-'))
  try {
    const outcome = await runBuiltBenchmarkWorker<WorkspaceRevocationReport>({
      worker: join(import.meta.dirname, '..', '.panedesk-build', 'workspace-revocation', 'workspace-revocation.worker.js'),
      args: [root], timeoutMs: 120_000,
    })
    if (outcome.exitCode !== 0 || outcome.report === undefined) throw new Error(`Workspace revocation benchmark failed: ${outcome.stderr}`)
    const report = outcome.report
    const budgets = { elapsedMs: ciTimeBudget(30_000) }
    console.log(JSON.stringify({ benchmark: benchmarkCase.id, report, budgets }))
    recordTimings(benchmarkCase, { elapsedMs: { ms: report.elapsedMs, cpuMs: report.cpuMs } }, budgets)
    recordPeakMemory(benchmarkCase, { worker: report.peakRssMb })
    expect(report.elapsedMs).toBeLessThanOrEqual(budgets.elapsedMs)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 150_000)
