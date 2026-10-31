/** Durable preview validation is independent of mutable provider catalogs. */
import { z } from 'zod'
import { defineDomain } from '@panedesk/dsh-storage-domain'
import { SEAT_ERROR_CODES, type SeatImportPlan, type SeatJson } from '@panedesk/dsh-seat'
import { parseDefinition } from './schema.ts'

const json: z.ZodType<SeatJson> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number(), z.string(), z.array(json), z.record(z.string(), json),
]))
const definition = z.unknown().transform((value, context) => {
  const parsed = parseDefinition(value)
  if ('status' in parsed) { context.addIssue({ code: 'custom', message: parsed.error.message }); return z.NEVER }
  return parsed
})
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const failureCode = z.string().refine(value => Object.hasOwn(SEAT_ERROR_CODES, value))
const plan = z.object({
  planId: z.uuid(), sourceFileHash: hash, mappingHash: hash,
  baseRevision: z.number().int().nonnegative(), rows: z.array(z.object({
    row: z.number().int(), seat: z.string().nullable(), definition: definition.nullable(), rowHash: hash,
    columnHashes: z.record(z.string(), hash), action: z.enum(['create', 'update', 'retain', 'conflict', 'tombstone', 'invalid']),
    selected: z.boolean(), differences: z.array(z.object({ field: z.string(), baseline: json, local: json,
      source: json, conflict: z.boolean() })),
    diagnostics: z.array(z.object({ code: failureCode,
      message: z.string(), alternative: z.string(), retryable: z.boolean(), effectState: z.enum(['none', 'committed', 'partial', 'unknown']) })),
  })),
}).transform((value): SeatImportPlan => { const parsed: unknown = value; return parsed as SeatImportPlan })

/** A preview owns its validated selection and original source path until expiry or commit. */
export const retainedPlanSchema = z.object({
  plan, sourcePath: z.string().min(1), expiresAt: z.number().int().nonnegative(),
  committedOperationId: z.string().min(1).optional(),
})
const initialPlans: Record<string, z.infer<typeof retainedPlanSchema>> = {}
/** Node-local preview state is atomically replaced without changing catalog revision. */
export const importPlansSpec = defineDomain({ name: 'seat_import_plans', version: 1, layout: 'single', tables: {},
  global: { schema: z.record(z.string(), retainedPlanSchema), initial: initialPlans },
})
