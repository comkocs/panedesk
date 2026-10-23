/** Existing upstream waterfalls retain their delegation and model-result semantics. */
import type { Context } from '@panedesk/cordis'
import type { GateContext, SeatGateService, SeatJson, SeatOperationId } from '@panedesk/dsh-seat'
import type {} from '@panedesk/dsh-compaction'
import type {} from '@panedesk/dsh-tools'
import type {} from '@panedesk/dsh-working-directory'
import type { Config } from './index.ts'
import { literalWriteTargets } from './memory.ts'
import { buildCheckpoint } from './checkpoint.ts'

/** Connect tool denial and precommit checkpoint contributions to their actual executors.
 * @param ctx - reversible consumer scope.
 * @param config - resolved checkpoint and tool settings.
 * @param gates - shared provider also exposed to direct service callers.
 */
export function installConsumers(ctx: Context, config: Config, gates: SeatGateService): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const upstream = await next()
    if (upstream.kind !== 'allow' || exec.agent === undefined) return upstream
    const seats = ctx.get('seats')
    if (!seats) return upstream
    const binding = await seats.binding({ sessionId: exec.agent.session.id })
    if (binding !== null && 'status' in binding) return { kind: 'deny', reason: binding.error.alternative }
    const nodeId = binding?.nodeId ?? (await ctx.get('seatEngine')?.nodeStatus())?.nodeId
    if (nodeId === undefined) return { kind: 'deny', reason: 'Seat node evidence is unavailable.' }
    const cwd = ctx.get('workingDirectory')?.get(exec.agent.session) ?? exec.agent.session.header.cwd
    const args = jsonRecord(exec.arguments)
    const listed = await seats.list({})
    const sessionId = exec.agent.session.id
    const view = listed.status === 'listed' ? listed.sessions.find(item => item.sessionId === sessionId) : undefined
    const base = {
      callId: `tool:${exec.agent.session.id}:${exec.callId}` as GateContext['callId'],
      operationId: `tool:${exec.agent.session.id}:${exec.callId}` as SeatOperationId,
      sessionId: exec.agent.session.id, nodeId, seat: binding?.kind === 'seat' ? binding.seat : null,
      observedAt: new Date().toISOString(), ...cwd === undefined ? {} : { cwd },
    }
    const decisions = [...await gates.evaluate({ ...base, hook: 'before-tool-call', toolName: exec.name, arguments: args,
      hasPendingWork: view !== undefined && (view.runningSubagents > 0 || view.busyReasons.some(reason => reason.kind === 'wait')),
    })]
    const targets: string[] = []
    if (['write', 'edit', 'Write', 'Edit', 'write_file', 'edit_file'].includes(exec.name)) {
      const target = args.file_path ?? args.path
      if (typeof target === 'string') targets.push(target)
    } else if (['seat_write', 'seat_edit'].includes(exec.name)) {
      const directories = ctx.get('seatDirectories')
      if (directories && typeof args.rootId === 'string' && typeof args.relativePath === 'string') {
        const root = (await directories.roots(exec.agent.session.id)).find(item => item.rootId === args.rootId)
        if (root) targets.push(`${root.path}/${args.relativePath}`)
      }
    } else if (['bash', 'Bash', 'shell'].includes(exec.name) && typeof args.command === 'string') targets.push(...literalWriteTargets(args.command))
    for (const [index, targetPath] of targets.entries()) {
      decisions.push(...await gates.evaluate({ ...base, callId: `${base.callId}:memory:${index}` as GateContext['callId'], hook: 'before-memory-write', targetPath,
        authorizedDirectories: binding?.kind === 'seat' ? binding.memoryDirectories : [], syntax: 'certain' }))
    }
    if (targets.length === 0 && ['bash', 'Bash', 'shell'].includes(exec.name) && typeof args.command === 'string') {
      decisions.push(...await gates.evaluate({ ...base, callId: `${base.callId}:uncertain` as GateContext['callId'],
        hook: 'before-memory-write', targetPath: '', authorizedDirectories: [], syntax: 'unknown' }))
    }
    const denied = decisions.find(result => result.outcome === 'deny')
    if (denied?.outcome === 'deny') return { kind: 'deny', reason: `${denied.reason.message} ${denied.alternative}${denied.audit === 'unavailable' ? ' Audit unavailable.' : ''}` }
    return upstream
  })
  ctx.on('compaction/checkpoint', async (payload, next) => {
    const delegated = await next()
    const seats = ctx.get('seats')
    if (!seats) return delegated
    const binding = await seats.binding({ sessionId: payload.session.id })
    if (!binding || 'status' in binding || binding.kind !== 'seat') return delegated
    const definition = await seats.resolve(binding.seat)
    if ('status' in definition) throw new Error(definition.error.alternative)
    const gateResults = await gates.evaluate({ hook: 'after-compaction',
      callId: `checkpoint:${payload.session.id}:${definition.revision}:${payload.session.seq}` as GateContext['callId'],
      operationId: `checkpoint:${payload.session.id}` as SeatOperationId, nodeId: binding.nodeId, seat: binding.seat,
      sessionId: payload.session.id, observedAt: new Date().toISOString(), summary: JSON.stringify(delegated.content),
      additionalTokenBudget: payload.additionalTokenBudget, seatRevision: definition.revision })
    const denial = gateResults.find(result => result.outcome === 'deny')
    if (denial?.outcome === 'deny') throw new Error(denial.alternative)
    const before = payload.estimateTokens(payload.checkpoint.content)
    const contribution = await buildCheckpoint(definition.checkpointFiles, definition.revision, config.checkpointMaxBytes,
      payload.additionalTokenBudget - (payload.estimateTokens(delegated.content) - before), config.ledgerCheckpointReserveTokens,
      text => payload.estimateTokens([...delegated.content, { type: 'text', text }]) - payload.estimateTokens(delegated.content))
    const content = [...delegated.content, ...contribution.text ? [{ type: 'text' as const, text: contribution.text }] : []]
    if (payload.estimateTokens(content) - before > payload.additionalTokenBudget) {
      throw new Error('Seat checkpoint exceeds the strict-shrink allowance.')
    }
    return { ...delegated, content,
      retryLimit: Math.min(delegated.retryLimit ?? config.checkpointRetryLimit, config.checkpointRetryLimit),
      validate: async () => {
        if (delegated.validate && !await delegated.validate()) return false
        const current = await seats.resolve(binding.seat)
        return !('status' in current) && current.revision === definition.revision && await contribution.validate()
      },
    }
  })
}

function jsonRecord(value: unknown): Readonly<Record<string, SeatJson>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  // ToolRuntime already losslessly materializes and freezes JSON arguments.
  return value as Readonly<Record<string, SeatJson>>
}
