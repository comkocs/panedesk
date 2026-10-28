/** Safe process-local and cross-process observations of the required accounting services. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@panedesk/cordis'
import { writeFileAtomic } from '@panedesk/dsh-atomic-write'
import type {} from './profile-context.ts'

/** Service availability at the settled startup audit, not a health or usage estimate. */
export interface KernelServiceStatus {
  readonly status: 'mounted' | 'missing' | 'disabled' | 'failed'
  /** Stable diagnostic code; never an exception message, path, or URL. */
  readonly cause: string
}

/** Latest accounting-service observation made by a model-running profile. */
export interface KernelStatus {
  readonly pid: number
  readonly time: string
  readonly services: Readonly<Record<'sessionLedger' | 'llmCache', KernelServiceStatus>>
}

/** Startup audit facts stripped of exception messages and module locations. */
export interface KernelEntryFailure {
  readonly id: string
  readonly kind: 'failed' | 'pending'
  readonly missing?: readonly string[]
  readonly importing?: boolean
  readonly error?: unknown
}

declare module '@panedesk/cordis' {
  interface Context {
    /** Read-only startup observations; absent before the initial Loader audit. */
    kernelStatus: KernelStatusService
  }
}

/** Immutable startup status shared with in-process usage consumers. */
export class KernelStatusService extends Service {
  constructor(ctx: Context, private readonly value: KernelStatus) {
    super(ctx, 'kernelStatus')
  }

  /** Read the startup audit without dispatching a model or accessing the journal.
   * @returns the immutable snapshot owned by this process, including unavailable services.
   */
  snapshot(): KernelStatus { return this.value }
}

/** Offline observers must not replace the main process's startup evidence. */
function kernelHome(ctx: Context): string | undefined {
  const profile = ctx.get('profileContext')
  return profile && !['ledger', 'ledger-watch', 'plugin'].includes(profile.name)
    && !profile.startedBundles.includes('@panedesk/dsh-ledger-app') ? profile.home : undefined
}

/** Mark a new main-process boot before mounting any configured entry.
 * @param ctx - launcher context after host preparation.
 * @returns after an atomic owner-only marker write, or immediately for offline/non-profile boots.
 */
export async function markKernelBoot(ctx: Context): Promise<void> {
  const home = kernelHome(ctx)
  if (home === undefined) return
  await writeFileAtomic(join(home, 'run/kernel-boot.json'), JSON.stringify({ pid: process.pid, time: new Date().toISOString() }) + '\n',
    { mode: 0o600, dirMode: 0o700 })
}

function failureCause(failure: KernelEntryFailure): string {
  if (failure.kind === 'pending') {
    const names = failure.missing?.filter(name => /^[A-Za-z][A-Za-z0-9_-]*$/.test(name)).sort() ?? []
    return `pending:${names.join(',') || 'unknown'}`
  }
  if (!failure.importing) return 'activation-failed'
  const code = typeof failure.error === 'object' && failure.error !== null && 'code' in failure.error ? failure.error.code : undefined
  return ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(String(code))
    ? `import-failed:${String(code)}` : 'import-failed'
}

/** Publish required-service status independently of the optional/required entry-id policy.
 * @param ctx - settled Loader context with optional profile launch facts.
 * @param failures - inactive entry diagnostics collected by the boot audit.
 * @returns after publishing an immutable service and atomic state file; failed persistence rejects startup.
 */
export async function publishKernelStatus(ctx: Context, failures: readonly KernelEntryFailure[]): Promise<void> {
  const home = kernelHome(ctx)
  if (home === undefined) return
  const entries = [...ctx.loader.entries()]
  const inspect = (service: string, id: string, module: string): KernelServiceStatus => {
    if (ctx.get(service) !== undefined) return Object.freeze({ status: 'mounted', cause: 'service-present' })
    const entry = entries.find(candidate => candidate.options.id === id || candidate.options.name === module)
    if (entry === undefined) return Object.freeze({ status: 'missing', cause: 'entry-missing' })
    const failure = failures.find(candidate => candidate.id === entry.options.id)
    if (failure !== undefined) return Object.freeze({ status: 'failed', cause: failureCause(failure) })
    if (entry.disabled) return Object.freeze({ status: 'disabled', cause: 'entry-disabled' })
    return Object.freeze({ status: 'failed', cause: 'service-unavailable' })
  }
  const status: KernelStatus = Object.freeze({
    pid: process.pid, time: new Date().toISOString(), services: Object.freeze({
      sessionLedger: inspect('sessionLedger', 'session-ledger-full', '@panedesk/dsh-session-ledger'),
      llmCache: inspect('llmCache', 'llm-cache', '@panedesk/dsh-llm-cache'),
    }),
  })
  await writeFileAtomic(join(home, 'run/kernel-status.json'), JSON.stringify(status) + '\n', { mode: 0o600, dirMode: 0o700 })
  new KernelStatusService(ctx, status)
  const unavailable = Object.entries(status.services).filter(([, value]) => value.status !== 'mounted')
  if (unavailable.length > 0) ctx.logger.error(`Session ledger not mounted: ${unavailable.map(([name, value]) => `${name}=${value.status}(${value.cause})`).join('; ')}`)
}

/** Cross-process read result; absent and invalid evidence never claim mounted services. */
export type KernelStatusRead = { readonly kind: 'available'; readonly status: KernelStatus; readonly stale: boolean }
  | { readonly kind: 'unavailable'; readonly cause: 'status-missing' | 'status-invalid' | 'status-unreadable' }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function processStamp(value: unknown): value is { pid: number; time: string } {
  return record(value) && typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0
    && typeof value.time === 'string' && Number.isFinite(Date.parse(value.time))
}

function serviceStatus(value: unknown): value is KernelServiceStatus {
  return record(value) && ['mounted', 'missing', 'disabled', 'failed'].includes(String(value.status))
    && typeof value.cause === 'string' && /^[A-Za-z0-9_,:-]+$/.test(value.cause) && value.cause.length <= 512
}

function kernelStatus(value: unknown): value is KernelStatus {
  if (!record(value) || !record(value.services)) return false
  const services = value.services
  return processStamp(value) && serviceStatus(services.sessionLedger) && serviceStatus(services.llmCache)
}

/** Read the last main-process status without changing its files or owning a journal writer.
 * @param home - resolved Harness home shared with the main process.
 * @returns validated status, marked stale for an exited process or a newer boot; typed absence/read failures otherwise.
 */
export async function readKernelStatus(home: string): Promise<KernelStatusRead> {
  let text: string
  try { text = await readFile(join(home, 'run/kernel-status.json'), 'utf8') } catch (error) {
    return { kind: 'unavailable', cause: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'status-missing' : 'status-unreadable' }
  }
  let status: unknown
  try { status = JSON.parse(text) } catch (error) {
    void error // Malformed persisted data has no trusted diagnostic text.
    return { kind: 'unavailable', cause: 'status-invalid' }
  }
  if (!kernelStatus(status)) return { kind: 'unavailable', cause: 'status-invalid' }
  let stale = false
  try { process.kill(status.pid, 0) } catch (error) {
    stale = (error as NodeJS.ErrnoException).code !== 'EPERM'
  }
  let marker: string
  try { marker = await readFile(join(home, 'run/kernel-boot.json'), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') stale = true
    return { kind: 'available', status, stale }
  }
  let boot: unknown
  try { boot = JSON.parse(marker) } catch (error) {
    void error // An unreadable latest-boot marker cannot establish freshness.
    return { kind: 'available', status, stale: true }
  }
  stale ||= !processStamp(boot) || Date.parse(boot.time) > Date.parse(status.time)
  return { kind: 'available', status, stale }
}
