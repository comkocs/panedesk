/** Standard ACP updates derived from committed DSH session events and live assistant streams. */

import type { Context } from '@panedesk/cordis'
import type { SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk'
import type { Session, SessionEvent } from '@panedesk/dsh-session'
import type { StreamChunk } from '@panedesk/dsh-llm'
import type {} from '@panedesk/dsh-token-meter'
import { assistantBlockToAcp } from './content.ts'

/** Live text coverage one streaming attempt already delivered to the client. */
export interface LiveAssistantCoverage {
  /** Live message id derived from the attempt; residual committed updates reuse it. */
  messageId: string
  /** Accumulated delta text per stream block index, in first-delta order. */
  deltas: ReadonlyMap<number, { kind: 'text' | 'reasoning'; text: string }>
}

/**
 * Project one live stream chunk ahead of its durable commit.
 * @param messageId - live message id derived from the streaming attempt.
 * @param chunk - raw chunk from the assistant stream.
 * @returns the ordered live text delta update, or none for non-text chunks.
 */
export function liveChunkUpdate(messageId: string, chunk: StreamChunk): SessionUpdate[] {
  if (chunk.type === 'text-delta' && chunk.text.length > 0) {
    return [{ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: chunk.text } }]
  }
  if (chunk.type === 'reasoning-delta' && chunk.text.length > 0) {
    return [{ sessionUpdate: 'agent_thought_chunk', messageId, content: { type: 'text', text: chunk.text } }]
  }
  return []
}

/**
 * Convert one committed assistant message and its context usage in block order.
 * Blocks whose text a live attempt already delivered are skipped, keeping the
 * committed projection residual; sessions without live coverage replay whole.
 * @param ctx - bridge context carrying attachment and token-meter services.
 * @param session - durable session used for context pressure.
 * @param event - committed assistant message event.
 * @param live - live coverage of the attempt that committed this message, if any.
 * @returns ordered standard thought, message, and optional usage updates.
 */
export async function assistantUpdates(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
  live?: LiveAssistantCoverage,
): Promise<SessionUpdate[]> {
  const updates: SessionUpdate[] = []
  const messageId = live?.messageId ?? event.data.message.id
  const delivered: Array<{ kind: 'text' | 'reasoning'; text: string }> = live === undefined ? [] : [...live.deltas.values()]
  let cursor = 0
  /** Whether the live attempt already delivered this block's exact text, advancing the cursor. */
  const covered = (candidate: { kind: 'text' | 'reasoning'; text: string }): boolean => {
    const chunk = delivered[cursor]
    if (chunk === undefined || chunk.kind !== candidate.kind || chunk.text !== candidate.text) return false
    cursor++
    return true
  }
  for (const block of event.data.message.content) {
    if (block.type === 'reasoning') {
      if (!covered({ kind: 'reasoning', text: block.text }) && block.text.length > 0) {
        updates.push({
          sessionUpdate: 'agent_thought_chunk',
          messageId,
          content: { type: 'text', text: block.text },
        })
      }
      continue
    }
    const content = await assistantBlockToAcp(ctx, block)
    if (content === undefined) continue
    if (content.type !== 'text' || !covered({ kind: 'text', text: content.text })) {
      updates.push({ sessionUpdate: 'agent_message_chunk', messageId, content })
    }
  }
  const usage = usageUpdate(ctx, session, event)
  if (usage !== undefined) updates.push(usage)
  return updates
}

/**
 * Start one generic ACP tool lifecycle from the durable call fact.
 * @param event - committed DSH tool-call event.
 * @returns the standard generic tool-call update.
 */
export function toolCallUpdate(event: SessionEvent<'tool/call'>): SessionUpdate {
  return {
    sessionUpdate: 'tool_call',
    toolCallId: event.data.callId,
    title: event.data.name,
    kind: 'other',
    status: 'in_progress',
    rawInput: parseToolArguments(event.data.arguments),
  }
}

/**
 * Finish one generic ACP tool lifecycle from its committed model-facing result.
 * @param ctx - bridge context carrying the attachment store.
 * @param event - committed DSH tool-result event.
 * @returns the standard completed or failed tool-call update.
 */
export async function toolResultUpdate(
  ctx: Context,
  event: SessionEvent<'tool/result'>,
): Promise<SessionUpdate> {
  const message = event.data.message
  const content: ToolCallContent[] = []
  for (const block of message.content) {
    const converted = await assistantBlockToAcp(ctx, block)
    if (converted !== undefined) content.push({ type: 'content' as const, content: converted })
  }
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: message.toolCallId,
    status: message.isError === true ? 'failed' : 'completed',
    content,
  }
}

/** Report current context occupancy only when DSH has both usage and capacity facts. */
function usageUpdate(
  ctx: Context,
  session: Session,
  event: SessionEvent<'assistant/message'>,
): SessionUpdate | undefined {
  if (event.data.usage === undefined) return undefined
  const size = session.requestContext()?.contextWindow
  const meter = ctx.get('tokenMeter')
  if (size === undefined || meter === undefined) return undefined
  return {
    sessionUpdate: 'usage_update',
    used: meter.measure(session).totalTokens,
    size,
  }
}

/** Preserve malformed model output as opaque input instead of dropping the call update. */
function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (_invalidModelJson) {
    return value
  }
}
