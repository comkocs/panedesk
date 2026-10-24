/** 来源快照是持久输入，读取时验证完整版本、任务和改面字段。 */
import { z } from 'zod'
import type * as T from '@panedesk/dsh-seat'

const id = z.string().min(1)
/** 持久来源快照校验器，不用于重授授权。 */
export const openingSnapshotSchema = z.object({
  reference: z.object({ providerId: id, reference: id, revision: id }),
  text: z.string(), digest: id, revision: id, taskIds: z.array(id),
  scopeEvidence: z.array(z.discriminatedUnion('status', [
    z.object({ status: z.literal('unknown'), taskId: id, reason: z.string(), alternative: z.literal('serial') }),
    z.object({ status: z.literal('known'), taskId: id, revision: id, repositoryId: id, baseRevision: id,
      entries: z.array(z.object({ kind: z.enum(['file', 'directory', 'pattern']), path: id, access: z.enum(['read', 'write']) })),
      patternSyntax: z.enum(['literal', 'glob-v1']), caseSensitive: z.boolean() }),
  ])),
}).transform((value): T.OpeningContextSnapshot => ({ ...value,
  reference: { ...value.reference, providerId: value.reference.providerId as T.OpeningProviderId,
    reference: value.reference.reference as T.OpeningContextReference['reference'] },
  digest: value.digest as T.SeatDigest, taskIds: value.taskIds.map(taskId => taskId as T.SeatTaskId),
  scopeEvidence: value.scopeEvidence.map(scope => scope.status === 'unknown'
    ? { ...scope, taskId: scope.taskId as T.SeatTaskId }
    : { ...scope, taskId: scope.taskId as T.SeatTaskId, repositoryId: scope.repositoryId as T.TaskRepositoryId }),
}))
