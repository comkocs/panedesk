/**
 * Transcript-only facts for one subagent node: the provider/model label and the most
 * recent tool invocation, both read strictly from a session's own log suffix.
 * The ledger's effective or requested model is never a fallback.
 *
 * @module @panedesk/dsh-client-ui-subagent-tree/transcript
 */

import type { SessionEvent } from '@panedesk/dsh-session'
import type { SubagentTranscriptFacts } from './tree.ts'

declare module '@panedesk/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A child started on a route that declares no reasoning efforts, so the
     * requested effort was not sent. Written by the delegation tool before the
     * first request header; the folded label shows it as "effort not applicable".
     */
    'subagent/effort-not-applicable': {
      /** Provider route the child was started on. */
      provider: string
      /** Provider-owned model id the child was started on. */
      model: string
    }
  }
}

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
  let activity: SubagentTranscriptFacts['activity']
  let model: string | null = null
  let lastToolCall: SubagentTranscriptFacts['lastToolCall'] = null
  // A route that declares no reasoning efforts records this note before its
  // first request header; the label keeps it where a declared effort would show.
  let effortNotApplicable = false
  for (let index = Math.max(0, inheritedEventCount); index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'turn/start') activity = 'running'
    else if (event.type === 'turn/end') activity = event.data.reason.kind === 'aborted' ? 'stopped' : 'idle'
    else if (event.type === 'subagent/effort-not-applicable') effortNotApplicable = true
    else if (event.type === 'request/header') {
      const config = event.data.header.config
      const effort = config.reasoningEffort ?? (effortNotApplicable ? 'effort not applicable / 档位不适用' : undefined)
      model = [config.provider, config.model, effort].filter(Boolean).join(' · ')
    } else if (event.type === 'assistant/message') {
      const source = event.data.message.source
      model = `${source.provider} · ${source.model}`
    }
    else if (event.type === 'tool/call') lastToolCall = { name: event.data.name, time: event.time }
  }
  return { model, modelSource: 'transcript', lastToolCall, ...(activity === undefined ? {} : { activity }) }
}
