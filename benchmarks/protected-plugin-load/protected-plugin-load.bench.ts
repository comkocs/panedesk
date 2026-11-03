/** Capture and verified loading of a plugin-sized protected input tree. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runBuiltBenchmarkWorker } from '../support/built-worker.ts'
import { ciTimeBudget } from '../support/calibration.ts'
import { recordPeakMemory, recordTimings } from '../support/scaling-report.ts'
import type { ProtectedPluginReport } from './protected-plugin-load.worker.ts'

const benchmarkCase = {
  id: 'protected-plugin-load',
  measures: 'Durable capture and 47 verified module reads of a 47-file, 204279-byte plugin tree.',
  affects: 'Granting workspace write access and loading protected plugins before executing their bytes.',
}

it('measures complete protected plugin tree comparisons without skipping digest reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'protected-plugin-bench-'))
  try {
    const outcome = await runBuiltBenchmarkWorker<ProtectedPluginReport>({
      worker: join(import.meta.dirname, '..', '.panedesk-build', 'protected-plugin-load', 'protected-plugin-load.worker.js'),
      args: [root], timeoutMs: 30_000,
    })
    if (outcome.exitCode !== 0 || outcome.report === undefined) throw new Error(`Protected plugin benchmark failed: ${outcome.stderr}`)
    const report = outcome.report
    const budgets = { captureMs: ciTimeBudget(250), loadsMs: ciTimeBudget(2500) }
    console.log(JSON.stringify({ benchmark: benchmarkCase.id, report, budgets }))
    recordTimings(benchmarkCase, {
      captureMs: { ms: report.captureMs, cpuMs: report.captureCpuMs },
      loadsMs: { ms: report.loadsMs, cpuMs: report.loadsCpuMs },
    }, budgets)
    recordPeakMemory(benchmarkCase, { worker: report.peakRssMb })
    expect(report.captureMs).toBeLessThanOrEqual(budgets.captureMs)
    expect(report.loadsMs).toBeLessThanOrEqual(budgets.loadsMs)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 40_000)

it('measures synthetic overlapping dependency-scale capture without retaining duplicate file bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'protected-overlap-bench-'))
  const overlapCase = {
    id: 'protected-plugin-overlapping-capture',
    measures: 'Durable capture of two synthetic linked roots, each containing 44494 files and 703177774 bytes.',
    affects: 'Granting workspace write access when protected plugin roots overlap.',
  }
  try {
    const outcome = await runBuiltBenchmarkWorker<ProtectedPluginReport>({
      worker: join(import.meta.dirname, '..', '.panedesk-build', 'protected-plugin-load', 'protected-plugin-load.worker.js'),
      args: [root, 'overlapping'], timeoutMs: 180_000,
    })
    if (outcome.exitCode !== 0 || outcome.report === undefined) throw new Error(`Overlapping input benchmark failed: ${outcome.stderr}`)
    const report = outcome.report
    const budgets = { captureMs: ciTimeBudget(30_000) }
    console.log(JSON.stringify({ benchmark: overlapCase.id, report, budgets }))
    recordTimings(overlapCase, { captureMs: { ms: report.captureMs, cpuMs: report.captureCpuMs } }, budgets)
    recordPeakMemory(overlapCase, { worker: report.peakRssMb })
    expect(report.captureMs).toBeLessThanOrEqual(budgets.captureMs)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 200_000)
