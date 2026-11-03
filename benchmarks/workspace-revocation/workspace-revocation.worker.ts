/** Synthetic node_modules inventory measures the production revocation traversal without native Windows timings. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { revokeWorkspaceTree } from '../../packages/sandbox/sandbox-windows-acl/src/revoke-tree.ts'

/** Raw traversal measurements; native descriptor and AccessCheck costs are excluded on this platform. */
export interface WorkspaceRevocationReport {
  files: number
  directories: number
  visited: number
  matched: number
  checks: number
  elapsedMs: number
  cpuMs: number
  peakRssMb: number
  nativeWindows: false
}

const root = process.argv[2]
if (root === undefined) throw new Error('Benchmark scratch root is required')
const packages = 1000
const filesPerPackage = 100
const grants = new Set([root])
mkdirSync(join(root, 'node_modules'))
for (let index = 0; index < packages; index++) {
  const directory = join(root, 'node_modules', `package-${index}`)
  mkdirSync(directory)
  if (index % 10 === 0) grants.add(directory)
  for (let file = 0; file < filesPerPackage; file++) writeFileSync(join(directory, `module-${file}.js`), 'export const value = 1\n')
}
let visited = 0
let checks = 0
const cpu = process.cpuUsage()
const started = performance.now()
const points = revokeWorkspaceTree(root, {
  hasExplicit: path => { visited++; return grants.has(path) },
  removeExplicit: path => { grants.delete(path) },
  permits: (path, _mask) => { checks++; return grants.has(path) },
})
const elapsedMs = performance.now() - started
const used = process.cpuUsage(cpu)
const report: WorkspaceRevocationReport = {
  files: packages * filesPerPackage, directories: packages + 2, visited, matched: points.length, checks,
  elapsedMs, cpuMs: (used.user + used.system) / 1000, peakRssMb: process.resourceUsage().maxRSS / 1024,
  nativeWindows: false,
}
process.stdout.write(`${JSON.stringify(report)}\n`)
