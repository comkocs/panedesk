/** A single catalog document under a lifetime native writer lease and revision CAS. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { tryLockExclusive } from '@panedesk/node-addon-system/flock'
import { defineDomain, type Domain, type DomainFacility } from '@panedesk/dsh-storage-domain'
import type { SeatAuthority, SeatDefinition, SeatDigest, SeatOperationId } from '@panedesk/dsh-seat'
import { parseDefinition } from './schema.ts'
import { refuse } from './errors.ts'
import { importPlansSpec, retainedPlanSchema } from './import-plan.ts'

const definitionSchema = z.unknown().transform((value, context) => {
  const result = parseDefinition(value)
  if ('status' in result) { context.addIssue({ code: 'custom', message: result.error.message }); return z.NEVER }
  return result
})
const catalogSchema = z.object({
  revision: z.number().int().nonnegative(), authority: z.enum(['import-source', 'seat-store']),
  definitions: z.array(definitionSchema),
  operations: z.record(z.string(), z.object({ digest: z.string(), revision: z.number().int().positive() })),
  authorizations: z.array(z.object({ reference: z.string(), authority: z.enum(['import-source', 'seat-store']), revision: z.number().int().positive() })),
})
/** Catalog, baselines and takeover audit share one atomic storage unit. */
export type SeatCatalog = z.infer<typeof catalogSchema>
const initialCatalog: SeatCatalog = { revision: 0, authority: 'import-source', definitions: [], operations: {}, authorizations: [] }
const spec = defineDomain({ name: 'seat_catalog', version: 1, layout: 'single', tables: {},
  global: { schema: catalogSchema, initial: initialCatalog },
})

/** Canonical SHA256 for operation and import equality, independent of object key order.
 * @param value - JSON-compatible value.
 * @returns digest of canonical UTF-8 bytes.
 */
export function digest(value: unknown): SeatDigest {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`
    if (typeof item === 'object' && item !== null) {
      return `{${Object.entries(item).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`
    }
    if (item === undefined) return 'null'
    return JSON.stringify(item)
  }
  return createHash('sha256').update(canonical(value)).digest('hex') as SeatDigest
}

/** Exclusive owner of the node catalog; callers close it before releasing the storage provider. */
export class SeatStore {
  private tail: Promise<void> = Promise.resolve()
  private closing = false
  private closeTask?: Promise<void>
  private constructor(private readonly domain: Domain<typeof spec>, private readonly lock: FileHandle,
    private readonly plans: Domain<typeof importPlansSpec>) {}

  /** Acquire ownership before opening the storage domain; contention never steals a writer.
   * @param facility - storage-domain routed to the node's private JSON backend.
   * @param directory - node-local private catalog directory.
   * @returns a writer with exclusive lifetime ownership.
   */
  static async open(facility: DomainFacility, directory: string): Promise<SeatStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const lockPath = join(directory, 'catalog.lock')
    const handle = await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    try {
      await tryLockExclusive(handle.fd)
      const held = await handle.stat({ bigint: true })
      const named = await stat(lockPath, { bigint: true })
      if (held.ino !== named.ino || held.dev !== named.dev) refuse('unavailable', 'Catalog writer ownership changed.', 'Retry after verifying the catalog directory.')
      const catalog = await facility.open(spec)
      try { return new SeatStore(catalog, handle, await facility.open(importPlansSpec)) }
      catch (error) { await catalog.close(); throw error }
    } catch (error) { await handle.close(); throw error }
  }

  /** Return an isolated snapshot; readers cannot mutate the authoritative domain.
   * @returns current committed catalog.
   */
  snapshot(): SeatCatalog { return structuredClone(this.domain.global.get()) }

  /** Read a persisted preview; expired identities never authorize a selection.
   * @param planId - opaque preview identity, never a filesystem path.
   * @returns retained plan or undefined after expiry or absence.
   */
  importPlan(planId: string): z.infer<typeof retainedPlanSchema> | undefined {
    const retained = this.plans.global.get()[planId]
    return retained && retained.expiresAt > Date.now() ? structuredClone(retained) : undefined
  }

  /** Retain a preview under the catalog writer lease and reclaim expired capacity.
   * @param retained - validated preview and expiry.
   * @param maxPlans - maximum live previews for this node.
   * @returns after the atomic document write is durable.
   */
  retainImportPlan(retained: z.infer<typeof retainedPlanSchema>, maxPlans: number): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Catalog is closing'))
    const run = this.tail.then(async () => {
      const current = Object.fromEntries(Object.entries(this.plans.global.get()).filter(([, value]) => value.expiresAt > Date.now()))
      if (Object.keys(current).length >= maxPlans) refuse('unavailable', 'Import preview capacity reached.', 'Wait for preview expiry before creating another plan.')
      current[retained.plan.planId] = retainedPlanSchema.parse(retained)
      await this.plans.global.set(current)
    })
    this.tail = run.then(() => {}, () => {})
    return run
  }

  /** Commit catalog edits, baselines, authority and operation receipt together.
   * @param expectedRevision - observed catalog revision.
   * @param operationId - stable caller identity.
   * @param request - request used for idempotency comparison.
   * @param update - pure transform, evaluated only after CAS succeeds.
   * @param conflictCode - import callers invalidate selections rather than allowing revision-only retries.
   * @returns the revision committed by this operation, including on replay.
   */
  mutate(expectedRevision: number, operationId: SeatOperationId, request: unknown,
    update: (catalog: SeatCatalog) => void, conflictCode: 'revision-conflict' | 'import-preview-stale' = 'revision-conflict'): Promise<number> {
    if (this.closing) return Promise.reject(new Error('Catalog is closing'))
    const run = this.tail.then(async () => {
      const current = this.snapshot()
      const requestDigest = digest(request)
      const previous = current.operations[operationId]
      if (previous !== undefined) {
        if (previous.digest !== requestDigest) refuse('operation-id-conflict', 'Operation identity has different contents.', 'Use the original request or a new operation identity.')
        return previous.revision
      }
      if (current.revision !== expectedRevision) refuse(conflictCode, 'Catalog revision changed.',
        conflictCode === 'import-preview-stale' ? 'Preview the source again.' : 'Read the catalog and retry with its revision.')
      update(current)
      current.revision += 1
      current.operations[operationId] = { digest: requestDigest, revision: current.revision }
      await this.domain.global.set(catalogSchema.parse(current))
      return current.revision
    })
    this.tail = run.then(() => {}, () => {})
    return run
  }

  /** Stop admission, drain writes, close the domain and then release the writer lease.
   * @returns after all owned storage work settles.
   */
  close(): Promise<void> {
    this.closing = true
    this.closeTask ??= this.tail.then(async () => {
      try { await this.plans.close() }
      finally { try { await this.domain.close() } finally { await this.lock.close() } }
    })
    return this.closeTask
  }
}

/** Apply an authorized handover without silently changing the import source policy.
 * @param catalog - isolated catalog being committed.
 * @param authority - externally authorized editing authority.
 * @param reference - external authorization audit reference.
 */
export function setCatalogAuthority(catalog: SeatCatalog, authority: SeatAuthority, reference: string): void {
  if (!reference.trim()) refuse('unauthorized', 'An authorization reference is required.', 'Obtain authorization before transferring authority.')
  catalog.authority = authority
  catalog.authorizations.push({ reference, authority, revision: catalog.revision + 1 })
  catalog.definitions = catalog.definitions.map((definition): SeatDefinition => ({ ...definition,
    ...(definition.source === undefined ? {} : { source: { ...definition.source, authority } }),
  }))
}
