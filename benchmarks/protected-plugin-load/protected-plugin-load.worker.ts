/** Plain-Node protected plugin capture and verified-load measurements. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { ProtectedInputIntegrity } from '@panedesk/dsh-app-boot'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'

/** Capture and repeat-load timings for one isolated plugin tree. */
export interface ProtectedPluginReport {
  readonly files: number
  readonly bytes: number
  readonly captureMs: number
  readonly captureCpuMs: number
  readonly loadsMs: number
  readonly loadsCpuMs: number
  readonly peakRssMb: number
}

assertBuiltBenchmarkRuntime(import.meta.url, { '@panedesk/dsh-app-boot': import.meta.resolve('@panedesk/dsh-app-boot') })
const root = process.argv[2]
if (root === undefined) throw new Error('A private benchmark root is required')
const workspace = join(root, 'plugin')
mkdirSync(workspace)
// Matches the installed Loader package's measured file count and total byte scale.
const files = 47
const bytes = 204_279
for (let index = 0; index < files; index++) {
  const size = Math.floor(bytes / files) + (index < bytes % files ? 1 : 0)
  writeFileSync(join(workspace, `${index}.js`), ' '.repeat(size))
}
const integrity = new ProtectedInputIntegrity(workspace, join(root, 'owner-state'))
integrity.observe(workspace)
let cpu = process.cpuUsage()
let start = performance.now()
integrity.grantWrite()
const captureMs = performance.now() - start
const captureCpu = process.cpuUsage(cpu)
cpu = process.cpuUsage()
start = performance.now()
for (let index = 0; index < files; index++) integrity.readExecutable(join(workspace, `${index}.js`))
const loadsMs = performance.now() - start
const loadsCpu = process.cpuUsage(cpu)
const report: ProtectedPluginReport = {
  files, bytes, captureMs, captureCpuMs: (captureCpu.user + captureCpu.system) / 1000,
  loadsMs, loadsCpuMs: (loadsCpu.user + loadsCpu.system) / 1000,
  peakRssMb: process.resourceUsage().maxRSS / (process.platform === 'darwin' ? 1024 * 1024 : 1024),
}
console.log(JSON.stringify(report))
