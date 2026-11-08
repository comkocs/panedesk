/**
 * Transcript-only facts for one subagent node: the model id and the most
 * recent tool invocation, both read strictly from a session's own log suffix.
 * The ledger's effective or requested model is never a fallback.
 *
 * @module @panedesk/dsh-client-ui-subagent-tree/transcript
 */

import type { SessionEvent } from '@panedesk/dsh-session'
import type { SubagentTranscriptFacts } from './tree.ts'

/**
 * Fold a session log's own suffix for the monitoring view.
 *
 * Only events past {@link inheritedEventCount} count: a fork seed's replayed
 * ancestor messages describe another session's model, not this one. The last
 * matching event in log order wins for both facts.
 * @param events - complete session event log, in sequence order.
 * @param inheritedEventCount - length of the fork-inherited prefix to skip.
 * @returns transcript-derived model and latest tool invocation, both `null` when unrecorded.
 */
export function foldTranscriptFacts(
  events: readonly SessionEvent[],
  inheritedEventCount: number,
): SubagentTranscriptFacts {
  let model: string | null = null
  let lastToolCall: SubagentTranscriptFacts['lastToolCall'] = null
  for (let index = Math.max(0, inheritedEventCount); index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'request/header') model = event.data.header.config.model
    else if (event.type === 'assistant/message') model = event.data.message.source.model
    else if (event.type === 'tool/call') lastToolCall = { name: event.data.name, time: event.time }
  }
  return { model, modelSource: 'transcript', lastToolCall }
}
