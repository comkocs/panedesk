/** Durable manual ingress retains validated opening text and its original catalog revision. */
import { z } from 'zod'
import type * as T from '@panedesk/dsh-seat'
import { parseDefinition } from './schema.ts'
import { digest } from './store.ts'

const schema = z.object({
  request: z.object({ seat: z.string().min(1), operationId: z.string().min(1), origin: z.enum(['manual', 'remote', 'engine']),
    nodeId: z.string().optional(), taskId: z.string().optional(), openingMode: z.enum(['auto', 'prefill']).optional(),
    expectedSeatRevision: z.number().int().optional() }),
  opening: z.object({ text: z.string(), digest: z.string().min(1), variables: z.object({
    seat: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), taskId: z.string().nullable() }) }),
  title: z.string(), definition: z.unknown(),
})

/** Decode local source data before reusing it from an engine journal.
 * @param value - retained source payload.
 * @returns frozen local input, excluding caller authority.
 */
export function readLocalOpenInput(value: unknown): Omit<T.SeatLocalOpenRequest, 'authority'> {
  const parsed = schema.parse(value)
  const definition = parseDefinition(parsed.definition)
  if ('status' in definition || digest(parsed.opening.text) !== parsed.opening.digest
    || parsed.request.seat !== definition.seat || parsed.opening.variables.seat !== definition.seat) {
    throw new Error('Retained local opening input is inconsistent')
  }
  const { nodeId, taskId, openingMode, expectedSeatRevision, ...request } = parsed.request
  return { definition, title: parsed.title,
    request: { ...request, seat: request.seat as T.SeatName, operationId: request.operationId as T.SeatOperationId,
      ...(nodeId === undefined ? {} : { nodeId: nodeId as T.SeatNodeId }),
      ...(taskId === undefined ? {} : { taskId: taskId as T.SeatTaskId }),
      ...(openingMode === undefined ? {} : { openingMode }),
      ...(expectedSeatRevision === undefined ? {} : { expectedSeatRevision }) },
    opening: { ...parsed.opening, digest: parsed.opening.digest as T.SeatDigest,
      variables: { ...parsed.opening.variables, seat: definition.seat, taskId: parsed.opening.variables.taskId as T.SeatTaskId | null } } }
}
