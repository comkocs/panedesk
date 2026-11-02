/** Rehearse the upstream npm release without credentials or registry writes. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { t } from 'tar'
import { pnpmInvocation } from '../pnpm-invocation.ts'

const registry = 'https://registry.npmjs.org/'
const internalPattern = new RegExp([
  'M[0-9]+[a-z]?[-_ ]?[A-Z][0-9]', '\\bM' + '8[ab]1?\\b', 'T-' + '00',
  'claude' + 'test', '_' + 'work/', 'panedesk' + '-us', '/home/' + 'panedesk',
  '/home/' + 'pdci', 'sub' + '2api', 'xiuxian' + 'mmo', 'xian' + 'xia',
  'pana' + 'desk', 'rul' + 'ing', 'requirement [0-9]', 'design (section|§)',
].join('|'), 'iu')

/** Per-category counts name files, not matched secret values. */
export interface ScanCounts {
  internal: number
  privatePath: number
  token: number
  fixtureKey: number
  credentials: number
}

/** One verified false positive: a single rule hit in one packed file. */
export interface ReleaseExemption {
  /** Packed package name whose tarball the entry was verified against. */
  package: string
  /** In-archive entry path, including the leading `package/` segment. */
  path: string
  /** Rule that matched the recorded snippet. */
  rule: keyof ScanCounts
  /** Hit fragment exactly as it appears in the packed path or content. */
  snippet: string
  /** Why this hit is a verified false positive, not a leak. */
  reason: string
}

/** An exemption that consumed one hit during a scan. */
export interface ExemptedHit {
  path: string
  rule: keyof ScanCounts
  snippet: string
}

/** Packed identity and sizes accompany every scan, including a rejected payload. */
export interface TarballScan {
  archive: string
  name: string
  version: string
  files: number
  bytes: number
  unpackedBytes: number
  counts: ScanCounts
  exempted: ExemptedHit[]
  stale: ReleaseExemption[]
  binarySkipped: number
  passed: boolean
}

interface RecordedHit {
  path: string
  text: string
  rules: Set<keyof ScanCounts>
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true })

/**
 * Decide from content whether an entry is a text file for word and path rules.
 * @param bytes - Raw entry content.
 * @returns True when the content holds a NUL byte or is not valid UTF-8.
 */
function isBinaryContent(bytes: Buffer): boolean {
  if (bytes.includes(0)) return true
  try { utf8Strict.decode(bytes); return false } catch { return true }
}

const exemptionRules = ['internal', 'privatePath', 'token', 'fixtureKey', 'credentials'] as const

/**
 * Validate one exemption record from the committed JSON list.
 * @param entry - Parsed JSON value at one array position.
 * @param index - Array position for the failure message.
 * @returns The record with its rule narrowed to a scan category.
 */
function parseExemption(entry: object, index: number): ReleaseExemption {
  if (!('package' in entry) || typeof entry.package !== 'string') throw new Error(`exemption ${String(index)} lacks a package string`)
  if (!('path' in entry) || typeof entry.path !== 'string') throw new Error(`exemption ${String(index)} lacks a path string`)
  if (!('snippet' in entry) || typeof entry.snippet !== 'string') throw new Error(`exemption ${String(index)} lacks a snippet string`)
  if (!('reason' in entry) || typeof entry.reason !== 'string') throw new Error(`exemption ${String(index)} lacks a reason string`)
  if (!('rule' in entry) || typeof entry.rule !== 'string') throw new Error(`exemption ${String(index)} lacks a rule string`)
  const rule = exemptionRules.find(candidate => candidate === entry.rule)
  if (rule === undefined) throw new Error(`exemption ${String(index)} names unknown rule ${entry.rule}`)
  return { package: entry.package, path: entry.path, rule, snippet: entry.snippet, reason: entry.reason }
}

/**
 * Load the committed exemption list with per-entry validation.
 * @returns Every verified false positive, or a throw when the file drifts from the schema.
 */
function loadExemptions(): readonly ReleaseExemption[] {
  const parsed: unknown = JSON.parse(
    readFileSync(fileURLToPath(new URL('./release-check-exemptions.json', import.meta.url)), 'utf8'))
  if (!Array.isArray(parsed)) throw new Error('release-check exemptions must be a JSON array')
  return parsed.map((entry: unknown, index: number) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`exemption ${String(index)} is not an object`)
    }
    return parseExemption(entry, index)
  })
}

const verifiedExemptions = loadExemptions()

/**
 * Remove URL queries and authentication values before persisting diagnostics.
 * @param text - Untrusted subprocess output.
 * @returns Text with sensitive request metadata removed.
 */
export function sanitizeOutput(text: string): string {
  return text.replace(/(https?:\/\/[^\s?]+)\?[^\s]*/giu, '$1?<redacted>')
    .replace(/\b(Authorization|Cookie|Set-Cookie):[^\r\n]*/giu, '$1: <redacted>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, '<address>')
}

/**
 * Inspect archive entries without extracting or executing their contents.
 *
 * Internal-word and path rules run only on text entries; a NUL byte or invalid
 * UTF-8 marks an entry binary and it is counted as skipped. Verified false
 * positives listed for this package consume their exact file and snippet;
 * remaining hits stay counted, and an entry that matches nothing is reported
 * as stale so the exemption list cannot drift from the packed bytes.
 * @param archive - A local npm tarball.
 * @param exemptions - Verified false positives; defaults to the committed list.
 * @returns Identity, byte counts, hits, exempted hits, stale entries and skipped binaries.
 */
export async function scanTarball(archive: string, exemptions: readonly ReleaseExemption[] = verifiedExemptions): Promise<TarballScan> {
  const counts: ScanCounts = { internal: 0, privatePath: 0, token: 0, fixtureKey: 0, credentials: 0 }
  const recorded: RecordedHit[] = []
  let files = 0
  let unpackedBytes = 0
  let binarySkipped = 0
  let manifest = ''
  await t({ file: archive, onReadEntry: (entry) => {
    if (entry.type === 'Directory') { entry.resume(); return }
    files++
    const chunks: Buffer[] = []
    entry.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    entry.on('end', () => {
      const bytes = Buffer.concat(chunks)
      unpackedBytes += bytes.byteLength
      const text = `${entry.path}\n${bytes.toString('utf8')}`
      const binary = isBinaryContent(bytes)
      if (binary) binarySkipped++
      const hit: RecordedHit = { path: entry.path, text, rules: new Set() }
      if (!binary && internalPattern.test(text)) hit.rules.add('internal')
      const privatePath = /(?:\/(?:home|Users)\/[^/\s]+\/|[A-Z]:[\\/](?:Users|private)[\\/]|@panedesk-private\/)/iu
      if (!binary && (privatePath.test(text) || /(?:^|[\\/])(?:priv|ticket-desk-private)[\\/]/iu.test(text))) hit.rules.add('privatePath')
      const token = /(?:\b(?:gh[pousr]_|github_pat_|npm_)[a-z0-9_]{20,}|\bsk-[a-z0-9_-]{16,})/iu
      if (token.test(text) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text)) hit.rules.add('token')
      const fixtureKey = /(?:api[_-]?key|secret|access[_-]?token)\s*[=:]\s*["']?(?:test|fake|fixture|dummy|mock)[-_][a-z0-9_-]+/iu
      if (fixtureKey.test(text)) hit.rules.add('fixtureKey')
      const credentials = new RegExp('(?:^|/)(?:\\.env(?:\\.[^/]+)?|\\.npmrc|\\.netrc|credentials(?:\\.[^/]+)?'
        + '|id_(?:rsa|ed25519)|[^/]+\\.(?:pem|p12|pfx))$', 'iu')
      if (credentials.test(entry.path)) hit.rules.add('credentials')
      if (!['File', 'OldFile'].includes(entry.type) || /(?:^|\/)\.\.(?:\/|$)|^\//u.test(entry.path)) hit.rules.add('credentials')
      if (hit.rules.size > 0) recorded.push(hit)
      if (entry.path === 'package/package.json') manifest = bytes.toString('utf8')
    })
  } })
  const parsed: unknown = JSON.parse(manifest)
  if (parsed === null || typeof parsed !== 'object' || !('name' in parsed) || !('version' in parsed)
    || typeof parsed.name !== 'string' || typeof parsed.version !== 'string') throw new Error('packed manifest lacks name/version')
  const exempted: ExemptedHit[] = []
  const stale: ReleaseExemption[] = []
  for (const entry of exemptions.filter(listed => listed.package === parsed.name)) {
    const covered = recorded.find(hit => hit.path === entry.path && hit.rules.has(entry.rule)
      && !exempted.some(consumed => consumed.path === entry.path && consumed.rule === entry.rule)
      && hit.text.includes(entry.snippet))
    if (covered === undefined) stale.push(entry)
    else exempted.push({ path: entry.path, rule: entry.rule, snippet: entry.snippet })
  }
  for (const hit of recorded) {
    for (const rule of hit.rules) {
      if (!exempted.some(consumed => consumed.path === hit.path && consumed.rule === rule)) counts[rule]++
    }
  }
  return { archive: basename(archive), name: parsed.name, version: parsed.version, files,
    bytes: readFileSync(archive).byteLength, unpackedBytes, counts, exempted, stale, binarySkipped,
    passed: Object.values(counts).every(count => count === 0) && stale.length === 0 }
}

/**
 * Select a public-registry dry-run tag, including npm's required prerelease tag.
 * @param archive - Local tarball path.
 * @param version - Packed package version.
 * @returns Arguments that never permit an actual publication.
 */
export function publishDryRunArgs(archive: string, version: string): string[] {
  return ['publish', '--dry-run', '--registry', registry, '--tag', version.includes('-') ? 'next' : 'latest', archive]
}

interface CheckStep { label: string; args: string[] }

/**
 * Keep release validation in the upstream family scripts.
 * @param output - Owned report directory; tarballs use a dedicated child directory.
 * @param additionalFrom - Supplementary native/vendor tarball directories; empty skips packed installation explicitly.
 * @returns Ordered, shell-free pnpm steps.
 */
export function releaseCheckPlan(output: string, additionalFrom: readonly string[]): CheckStep[] {
  const packed = join(output, 'tarballs')
  const steps = [
    { label: 'verify', args: ['run', 'release:verify', '--family', 'dsh'] },
    { label: 'pack', args: ['run', 'release:pack', '--family', 'dsh', '--out', packed] },
  ]
  if (additionalFrom.length > 0) steps.push({
    label: 'packed-install',
    args: ['run', 'release:verify-packed-install', '--family', 'dsh', '--from', packed,
      ...additionalFrom.flatMap(path => ['--from', path])],
  })
  return steps
}

function run(command: string, args: string[], output: string): number {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true', LANG: 'C.UTF-8' } })
  writeFileSync(output, sanitizeOutput(`${result.stdout}${result.stderr}${result.error?.message ?? ''}`))
  return result.status ?? 1
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    out: { type: 'string' }, from: { type: 'string', multiple: true }, 'scan-only': { type: 'string' },
  }, allowPositionals: false })
  if (!values.out) throw new Error('usage: pnpm run release:check --out <new directory>'
    + ' [--from <vendor/native tarballs>] [--scan-only <tarball>]')
  const output = resolve(values.out)
  mkdirSync(output, { recursive: false })
  const steps: { label: string; exitCode: number }[] = []
  const packages: TarballScan[] = []
  let passed = true
  if (values['scan-only']) {
    packages.push(await scanTarball(resolve(values['scan-only'])))
  } else {
    for (const step of releaseCheckPlan(output, values.from ?? [])) {
      const invocation = pnpmInvocation(step.args)
      const exitCode = run(invocation.command, invocation.args, join(output, `${step.label}.log`))
      steps.push({ label: step.label, exitCode })
      if (exitCode !== 0) { passed = false; break }
    }
    const packed = join(output, 'tarballs')
    if (steps.some(step => step.label === 'pack' && step.exitCode === 0)) {
      for (const filename of readdirSync(packed).filter(name => name.endsWith('.tgz')).sort()) {
        const tarball = join(packed, filename)
        const scan = await scanTarball(tarball)
        packages.push(scan)
        const exitCode = run('npm', publishDryRunArgs(tarball, scan.version), join(output, `${filename}.dry-run.log`))
        steps.push({ label: `dry-run:${filename}`, exitCode })
        if (exitCode !== 0) passed = false
      }
    }
    for (const [index, name] of [...new Set(['panedesk', 'pdesk', '@panedesk/cli', ...packages.map(pkg => pkg.name)])].entries()) {
      const exitCode = run('npm', ['view', name, 'name', 'version', '--registry', registry],
        join(output, `availability-${String(index)}.log`))
      steps.push({ label: `availability:${name}`, exitCode })
    }
  }
  passed = passed && packages.length > 0 && packages.every(pkg => pkg.passed)
  const totals = {
    hits: packages.reduce((sum, pkg) => sum + pkg.counts.internal + pkg.counts.privatePath
      + pkg.counts.token + pkg.counts.fixtureKey + pkg.counts.credentials, 0),
    exempted: packages.reduce((sum, pkg) => sum + pkg.exempted.length, 0),
    binarySkipped: packages.reduce((sum, pkg) => sum + pkg.binarySkipped, 0),
    staleExemptions: packages.reduce((sum, pkg) => sum + pkg.stale.length, 0),
  }
  const report = { passed, registry, steps, packages, totals,
    packedInstall: values.from?.length ? 'requested' : 'not run: supply vendor and native tarballs with --from',
    availability: 'E404 indicates an unregistered name, not registration authority;'
      + ' the scoped namespace requires organization setup before publication.' }
  writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`release check: ${passed ? 'passed' : 'failed'}; ${String(packages.length)} package(s);`
    + ` hits ${String(totals.hits)}, exempted ${String(totals.exempted)},`
    + ` stale ${String(totals.staleExemptions)}, binary skipped ${String(totals.binarySkipped)}; report.json`)
  if (!passed) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(sanitizeOutput(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  })
}
