/** Plain-Node protected plugin capture and verified-load measurements. */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { ProtectedInputIntegrity } from '@panedesk/dsh-app-boot'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'

/** Capture and repeat-load timings for one isolated plugin tree. */
export interface ProtectedPluginReport {
  readonly files: number
  readonly bytes: number
  readonly roots: number
  readonly synthetic: true
  readonly captureMs: number
  readonly captureCpuMs: number
  readonly loadsMs: number
  readonly loadsCpuMs: number
  readonly peakRssMb: number
}

assertBuiltBenchmarkRuntime(import.meta.url, { '@panedesk/dsh-app-boot': import.meta.resolve('@panedesk/dsh-app-boot') })
const root = process.argv[2]
if (root === undefined) throw new Error('A private benchmark root is required')
const workspaceRoot = join(root, 'workspace')
const workspace = join(workspaceRoot, 'plugin')
mkdirSync(workspace, { recursive: true })
const overlapping = process.argv[3] === 'overlapping'
// Fixed synthetic counts model measured scale, not an installed dependency graph.
const files = overlapping ? 44_494 : 47
const bytes = overlapping ? 703_177_774 : 204_279
for (let index = 0; index < files; index++) {
  const size = Math.floor(bytes / files) + (index < bytes % files ? 1 : 0)
  const content = Buffer.alloc(size, 32)
  content.write(String(index))
  writeFileSync(join(workspace, `${index}.js`), content)
}
const integrity = new ProtectedInputIntegrity(workspaceRoot, join(root, 'owner-state'))
if (overlapping) {
  for (const name of ['first', 'second']) {
    const alias = join(workspaceRoot, name)
    symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
    integrity.observe(alias)
  }
} else integrity.observe(workspace)
let cpu = process.cpuUsage()
let start = performance.now()
integrity.grantWrite()
const captureMs = performance.now() - start
const captureCpu = process.cpuUsage(cpu)
cpu = process.cpuUsage()
start = performance.now()
if (!overlapping) for (let index = 0; index < files; index++) integrity.readExecutable(join(workspace, `${index}.js`))
const loadsMs = performance.now() - start
const loadsCpu = process.cpuUsage(cpu)
const report: ProtectedPluginReport = {
  files, bytes, roots: overlapping ? 2 : 1, synthetic: true,
  captureMs, captureCpuMs: (captureCpu.user + captureCpu.system) / 1000,
  loadsMs, loadsCpuMs: (loadsCpu.user + loadsCpu.system) / 1000,
  peakRssMb: process.resourceUsage().maxRSS / (process.platform === 'darwin' ? 1024 * 1024 : 1024),
}
console.log(JSON.stringify(report))
