/** Action occurrences never enter the legacy Session-bound task table. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@panedesk/dsh-storage-domain'
import { scheduleTaskSchema } from './storage.ts'
import type { ScheduleId } from './types.ts'

/** A pending occurrence is frozen before dispatch, including its next target. */
export const scheduleActionTaskSchema = z.object({
  record: scheduleTaskSchema.shape.record,
  actionId: z.string().trim().min(1),
  payload: z.json(),
  status: z.enum(['active', 'inactive']),
  pending: z.object({
    eventId: z.string().min(1),
    scheduledAt: z.iso.datetime(),
    nextScheduledAt: z.iso.datetime().optional(),
  }).strict().optional(),
  lastReceipt: z.object({
    eventId: z.string().min(1),
    scheduledAt: z.iso.datetime(),
    status: z.enum(['accepted', 'skipped-disabled']),
  }).strict().optional(),
}).strict()

/** Persisted action state with no Session binding or legacy record changes. */
export type ScheduleActionTask = z.infer<typeof scheduleActionTaskSchema>

/** Separate versioned domain for opt-in action scheduling. */
export const scheduleActionsDomain = defineDomain({
  name: 'schedule_actions', version: 1,
  tables: { tasks: domainTable<ScheduleId, ScheduleActionTask>(scheduleActionTaskSchema) },
})
