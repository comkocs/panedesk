/** Runtime observers retain references, not copies of conversation or subagent output. */
import { createHash } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@panedesk/cordis'
import type { Session, SessionEvent, SessionId } from '@panedesk/dsh-session'
import type { SubagentRunInfo, SubagentRunEndInfo } from '@panedesk/dsh-subagent'
import type { Agent } from '@panedesk/dsh-agent'
import { carrierKeyOf } from '@panedesk/dsh-scope'
import type {} from '@panedesk/dsh-message-delivery'
import type {} from '@panedesk/dsh-session-persistence'
import type {} from '@panedesk/dsh-tool-present/types'
import type {} from '@panedesk/dsh-workspace-changes'
import type TraceStore from './index.ts'
import type { TraceReference } from './types.ts'

/** One file a write or edit tool changed, as stored on the tool result. */
interface ToolFileDiff { path: string; oldText: string | null; newText: string }

/** File-changing tools whose result carries a diff. A shell write has no per-call diff here. */
const FILE_CHANGE_TOOLS = new Set(['write', 'edit'])

/** Install reversible observers and drain asynchronous capture before database disposal.
 * @param ctx Host event owner.
 * @param store Single project writer.
 * @returns Drain to await before closing project databases.
 */
export function installCapture(ctx: Context, store: TraceStore): () => Promise<void> {
  const pending = new Set<Promise<void>>()
  const models = new Map<SessionId, string>()
  const observe = (operation: Promise<void>): void => {
    const settled = operation.catch(error => ctx.logger.warn('Trace capture failed / 事项采集失败', error))
    pending.add(settled)
    void settled.finally(() => { pending.delete(settled) })
  }
  ctx.on('session/created', session => {
    if (!store.recordsSession(session)) return
    observe(store.capture(session.id, { type: 'session/started', key: `session:${session.id}:start:${session.seq}`,
      payload: '{}', time: Date.now() }))
  })
  ctx.on('session/disposed', session => {
    if (store.recordsSession(session)) observe(store.capture(session.id, { type: 'session/ended', key: `session:${session.id}:end:${session.seq}`,
      payload: '{}', time: Date.now(), model: models.get(session.id) }))
    models.delete(session.id)
  })
  ctx.on('session/event', (session, event) => {
    if (!store.recordsSession(session)) return
    if (event.type === 'request/context') { models.set(session.id, event.data.model); return }
    if (event.type !== 'turn/start' && event.type !== 'turn/end' && event.type !== 'deliverables/presented'
      && event.type !== 'user/message' && event.type !== 'assistant/message'
      && !(event.type === 'tool/call' && event.data.name === 'bash')) return
    const references: Omit<TraceReference, 'id' | 'eventId'>[] = [{
      kind: 'session-slice', sessionId: session.id, seqStart: event.seq, seqEnd: event.seq,
      path: null, beforeHash: null, afterHash: null, summary: event.type, diffFile: null,
    }]
    if (event.type === 'deliverables/presented') for (const file of event.data.files) references.push({
      kind: 'attachment', sessionId: session.id, seqStart: event.seq, seqEnd: event.seq,
      path: file.path, beforeHash: null, afterHash: null, summary: file.description ?? '', diffFile: null,
    })
    observe(store.capture(session.id, { type: event.type, key: `session:${session.id}:${event.seq}`,
      payload: '{}', seqStart: event.seq, seqEnd: event.seq, time: event.time,
      model: models.get(session.id), actor: event.type === 'user/message' ? 'user' : undefined }, references))
  })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'tool/result' || !store.recordsSession(session)) return
    observe(captureToolChange(ctx, store, session, event, models))
  })
  for (const edge of ['subagent/start', 'subagent/end'] as const) ctx.on(edge, function (this: object, info: SubagentRunInfo | SubagentRunEndInfo) {
    const parent = carrierKeyOf(this) as Agent
    if (!store.recordsSession(parent.session)) return
    observe(store.capture(parent.id, { type: edge, key: `${edge}:${info.runId}`, time: Date.now(),
      observedSessionId: info.id,
      payload: JSON.stringify({ runId: info.runId, provider: info.provider, local: info.local,
        ...'stopReason' in info ? { stopReason: info.stopReason } : {} }), actor: 'subagent', model: models.get(info.id) }))
  })
  ctx.on('message/state', event => {
    const sessionIds = new Set([event.data.senderSessionId, event.data.targetSessionId])
    for (const sessionId of sessionIds) {
      if (sessionId === null) continue
      observe(store.capture(sessionId, { type: `message/${event.data.transition}`,
        key: `message:${event.nodeId}:${event.data.messageId}:${event.data.stateVersion}:${event.data.transition}:${sessionId}`,
        payload: JSON.stringify(event.data), time: event.data.observedAt, model: models.get(sessionId) }))
    }
  })
  ctx.on('workspace-changes/include-child', session => store.recordsSession(session) ? true : undefined)
  ctx.inject(['workspaceChanges'], changesCtx => {
    changesCtx.on('workspace-changes/recorded', (session, seq, summary) => {
      const operation = (async () => {
        const directory = await store.diffDirectory(session)
        if (directory === undefined) return
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const references: Omit<TraceReference, 'id' | 'eventId'>[] = []
        for (const [index, file] of summary.files.entries()) {
          const diff = await changesCtx.workspaceChanges.diff(session.id, seq, index, new AbortController().signal)
          const text = JSON.stringify(diff)
          const filename = `${createHash('sha256').update(`${session.id}:${seq}:${index}`).digest('hex')}.json`
          const handle = await open(join(directory, filename), 'w', 0o600)
          try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
          references.push({ kind: 'change', sessionId: session.id, seqStart: seq, seqEnd: seq, path: file.path,
            beforeHash: diff!.beforeHash, afterHash: diff!.afterHash,
            summary: JSON.stringify(file), diffFile: filename })
        }
        await store.capture(session.id, { type: 'workspace/changes', key: `session:${session.id}:${seq}`,
          payload: JSON.stringify(summary), seqStart: seq, seqEnd: seq, time: Date.now(), model: models.get(session.id) }, references)
      })()
      observe(operation)
      return operation
    })
  })
  return async () => { await Promise.all(pending) }
}

/** Read the file diffs a write or edit tool stored on its result.
 * @param meta Tool-private presentation payload.
 * @returns Valid file diffs, or an empty list when this result carries none.
 */
function fileDiffs(meta: unknown): ToolFileDiff[] {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return []
  const diffs = (meta as { diffs?: unknown }).diffs
  if (!Array.isArray(diffs)) return []
  return diffs.flatMap((entry): ToolFileDiff[] => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const { path, oldText, newText } = entry as { path?: unknown; oldText?: unknown; newText?: unknown }
    if (typeof path !== 'string' || path.length === 0) return []
    if ((oldText !== null && typeof oldText !== 'string') || typeof newText !== 'string') return []
    return [{ path, oldText, newText }]
  })
}

/** One line of what a file edit did, without copying the file contents into the timeline.
 * @param diff Stored before and after text of one hunk.
 * @returns Added and removed line counts.
 */
function diffSummary(diff: ToolFileDiff): string {
  const before = diff.oldText?.split('\n') ?? []
  const after = diff.newText.split('\n')
  const removed = before.filter(line => !after.includes(line)).length
  const added = after.filter(line => !before.includes(line)).length
  return diff.oldText === null ? `created ${diff.path}` : `edited ${diff.path} (+${added} -${removed})`
}

/** Record one file-changing tool result as its own timeline event and a change reference.
 * @param ctx Host event owner, used to read the paired tool call.
 * @param store Single project writer.
 * @param session Session that appended the tool result.
 * @param event Completed tool result.
 * @param models Model last seen for each session.
 * @returns After the event commits, or immediately when the result is not a file change.
 */
async function captureToolChange(
  ctx: Context, store: TraceStore, session: Session, event: SessionEvent<'tool/result'>, models: Map<SessionId, string>,
): Promise<void> {
  if (event.data.message.isError === true) return
  const callSeq = event.sourceEventSeqs?.[0]
  if (callSeq === undefined) return
  const handle = await ctx.sessionPersistence.open(session.id, 'read')
  let toolName: string
  const diffs = fileDiffs(event.data.meta)
  try {
    const call = (await handle.read(callSeq, 1)).events[0]
    if (call?.type !== 'tool/call' || call.seq !== callSeq || !FILE_CHANGE_TOOLS.has(call.data.name)) return
    toolName = call.data.name
    if (toolName === 'write' && diffs.length === 0) {
      const args = JSON.parse(call.data.arguments) as { file_path: string; content: string }
      diffs.push({ path: args.file_path, oldText: null, newText: args.content })
    }
  } finally { await handle.close() }
  if (diffs.length === 0) return
  const directory = await store.diffDirectory(session)
  if (directory === undefined) return
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const references: Omit<TraceReference, 'id' | 'eventId'>[] = []
  for (const [index, diff] of diffs.entries()) {
    const removed = diff.oldText === null ? [] : diff.oldText.split('\n')
    const added = diff.newText.split('\n')
    const text = JSON.stringify({ kind: 'text', path: diff.path, tool: toolName,
      before: diff.oldText !== null, after: true, hunks: [{
        oldStart: 1, oldLines: removed.length, newStart: 1, newLines: added.length,
        lines: [...removed.map(line => `-${line}`), ...added.map(line => `+${line}`)],
      }] })
    const filename = `${createHash('sha256').update(`${session.id}:${event.seq}:${index}`).digest('hex')}.json`
    const handle = await open(join(directory, filename), 'w', 0o600)
    try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
    references.push({ kind: 'change', sessionId: session.id, seqStart: event.seq, seqEnd: event.seq, path: diff.path,
      beforeHash: null, afterHash: null, summary: diffSummary(diff), diffFile: filename })
  }
  const summary = references.map(reference => reference.summary).join('; ')
  await store.capture(session.id, { type: 'file/changed', key: `file:${session.id}:${event.seq}`,
    payload: JSON.stringify({ tool: toolName, summary, paths: diffs.map(diff => diff.path) }),
    seqStart: event.seq, seqEnd: event.seq, time: event.time, model: models.get(session.id) }, references)
}
