/** Runtime observers retain references, not copies of conversation or subagent output. */
import { createHash } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@panedesk/cordis'
import type { SessionId } from '@panedesk/dsh-session'
import type { SubagentRunInfo, SubagentRunEndInfo } from '@panedesk/dsh-subagent'
import type { Agent } from '@panedesk/dsh-agent'
import { carrierKeyOf } from '@panedesk/dsh-scope'
import type {} from '@panedesk/dsh-message-delivery'
import type {} from '@panedesk/dsh-tool-present/types'
import type {} from '@panedesk/dsh-workspace-changes'
import type TraceStore from './index.ts'
import type { TraceReference } from './types.ts'

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
      && event.type !== 'user/message' && event.type !== 'assistant/message') return
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
