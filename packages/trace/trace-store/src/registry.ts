/** Global workspace-path mappings; trace switches are not model-editable settings. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@panedesk/dsh-storage-domain'
import type { ProjectId, TraceStatus } from './types.ts'
import type { SessionId } from '@panedesk/dsh-session'

/** A canonical workspace path keeps its project identity even after workspace registration is recreated. */
export const registrySpec = defineDomain({
  name: 'project_traces', version: 1,
  tables: { workspaces: domainTable<string, TraceStatus>(z.object({
    projectId: z.string().transform(value => value as ProjectId).nullable(),
    enabled: z.boolean().default(false), strict: z.boolean().default(false),
    plannerSessionId: z.string().transform(value => value as SessionId).nullable().default(null),
  })) },
})

/** Unregistered workspaces neither create a database nor collect events. */
export const disabledStatus: TraceStatus = { projectId: null, enabled: false, strict: false, plannerSessionId: null }
