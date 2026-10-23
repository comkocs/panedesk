/** File-boundary validation and explicit default resolution for node-local definitions. */
import path from 'node:path'
import { z } from 'zod'
import type { SeatDefinition, SeatNodeId, SeatRejected } from '@panedesk/dsh-seat'
import { rejected } from './errors.ts'

const positive = z.number().int().positive()
const text = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1) }),
  z.object({ kind: z.literal('file'), path: z.string().min(1), section: z.string().optional() }),
])
const absolute = z.string().refine(value => path.isAbsolute(value), 'Expected an absolute path')
const json: z.ZodType<import('@panedesk/dsh-seat').SeatJson> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number(), z.string(), z.array(json), z.record(z.string(), json),
]))
const source = z.object({
  sourcePath: absolute, sourceFileHash: z.string(), rowHash: z.string(), mappingHash: z.string(),
  columnHashes: z.record(z.string(), z.string()), baseline: z.record(z.string(), json),
  authority: z.enum(['import-source', 'seat-store']),
})
const trigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('schedule'), selector: z.record(z.string(), json), timeZone: z.string() }),
  z.object({ kind: z.literal('git'), repositoryId: z.string(), ref: z.string() }),
  z.object({ kind: z.literal('external'), sourceId: z.string(), eventType: z.string().optional() }),
  z.object({ kind: z.literal('window-ended'), seat: z.string(), on: z.enum(['closed', 'can-close']) }),
  z.object({ kind: z.literal('handoff-timeout'), timeoutMinutes: positive }),
  z.object({ kind: z.literal('manual'), origin: z.enum(['manual', 'remote']) }),
])
const shape = z.object({
  schemaVersion: z.literal(1), revision: positive, seat: z.string().trim().min(1),
  platform: z.enum(['desktop', 'vscode', 'server']), node: z.string().min(1), projectId: z.string().min(1),
  directories: z.array(z.object({ path: absolute, startup: z.boolean() })).min(1),
  memoryDirectories: z.array(absolute), opening: text, openingInstructionFiles: z.array(absolute),
  agentPreset: z.string().min(1), provider: z.string().min(1), model: z.string().min(1),
  reasoningEffort: z.string().min(1), permissionPreset: z.string().min(1),
  subscriptions: z.array(absolute), checkpointFiles: z.array(z.object({
    path: absolute, section: z.string().min(1), maxBytes: positive, required: z.boolean(),
  })), wakeTemplate: text.optional(), maxOpenSessions: positive, maxActiveSubagents: positive,
  contextThresholdTokens: positive.optional(), subagentContextThresholdTokens: positive,
  pollingThreshold: positive.optional(), maxSleepSeconds: positive.optional(),
  worktree: z.object({ clientTreesPerSlot: positive, staleOnSettle: z.literal('notify'),
    lightByDefault: z.boolean(), staleHours: positive }),
  rules: z.array(z.object({
    id: z.string().min(1), enabled: z.boolean(), trigger,
    mode: z.enum(['off', 'remind', 'auto']).optional(),
    timeWindows: z.array(z.object({ timeZone: z.string(), start: z.string(), end: z.string(),
      weekdays: z.array(z.number().int().min(0).max(6)).optional() })),
    exclusiveTags: z.array(z.string().min(1)),
    windowBudgetUsd: z.string().regex(/^\d+$/).optional(), dailyBudgetUsd: z.string().regex(/^\d+$/).optional(),
    modelAccountConcurrency: z.array(z.object({ accountLabel: z.string(), limit: positive })).optional(),
    timeoutMinutes: positive.optional(),
  })), source: source.optional(),
})

/** Dynamic catalogs are supplied by the installed runtime, never guessed from model names. */
export interface DefinitionCatalogs {
  nodeId: SeatNodeId
  nodeAliases: Readonly<Record<string, SeatNodeId>>
  defaults: Partial<SeatDefinition>
  validateOptions(definition: SeatDefinition): Promise<SeatRejected | null>
}

/** Validate persisted or imported JSON without consulting mutable runtime catalogs.
 * @param value - untrusted definition record.
 * @returns a validated record or structured diagnostics.
 */
export function parseDefinition(value: unknown): SeatDefinition | SeatRejected {
  const parsed = shape.safeParse(value)
  if (!parsed.success) return rejected('invalid-definition', parsed.error.issues.map(x => `${x.path.join('.')}: ${x.message}`).join('; '), 'Correct the definition and preview again.')
  const validated: unknown = parsed.data
  const definition = validated as SeatDefinition
  const paths = definition.directories.map(directory => path.normalize(directory.path))
  if (definition.directories.filter(directory => directory.startup).length !== 1 || new Set(paths).size !== paths.length) {
    return rejected('invalid-definition', 'Select exactly one startup directory and distinct directory paths.', 'Correct the directory list.')
  }
  if (new Set(definition.rules.map(rule => rule.id)).size !== definition.rules.length) {
    return rejected('invalid-definition', 'Rule identities must be unique.', 'Assign distinct rule identities.')
  }
  if (definition.rules.some(rule => rule.trigger.kind === 'window-ended' && rule.trigger.seat === definition.seat)) {
    return rejected('rule-self-loop', 'An unconditional seat self-trigger is not allowed.', 'Select another target seat.')
  }
  for (const pointer of [definition.opening, definition.wakeTemplate]) {
    if (pointer?.kind === 'file' && !path.isAbsolute(pointer.path)) {
      return rejected('invalid-definition', 'Text references require absolute paths.', 'Provide an absolute reference path.')
    }
  }
  return definition
}

/** Resolve defaults once before validation and freeze the selected runtime options.
 * @param input - imported or edited fields.
 * @param catalogs - current node and installed option catalogs.
 * @returns fully resolved definition or a refusal before side effects.
 */
export async function resolveSeat(input: Partial<SeatDefinition>, catalogs: DefinitionCatalogs): Promise<SeatDefinition | SeatRejected> {
  const definition = parseDefinition({
    schemaVersion: 1, revision: 1, memoryDirectories: [], openingInstructionFiles: [], subscriptions: [],
    checkpointFiles: [], maxOpenSessions: 1, maxActiveSubagents: 4, subagentContextThresholdTokens: 400000,
    rules: [], ...catalogs.defaults, ...input,
  })
  if ('status' in definition) return definition
  if (catalogs.nodeAliases[definition.node] !== catalogs.nodeId) {
    return rejected('cross-node-unsupported', 'The definition does not belong to this node.', 'Run the operation on its configured node.')
  }
  const error = await catalogs.validateOptions(definition)
  return error ?? definition
}
