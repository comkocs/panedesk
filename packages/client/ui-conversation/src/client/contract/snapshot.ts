/** Target-neutral Conversation state assembled from one Session event window. */
import type { SessionSnapshot } from '@panedesk/dsh-api-session-controller/client'
import type { ConversationViewSnapshotStore } from './conversation.ts'

/** Latest registered target snapshots and their shell-level activity. */
export interface ConversationSnapshot {
  readonly views: ConversationViewSnapshotStore
  readonly activeTargets: ReadonlySet<string>
}

/** Empty Conversation value used before a Session binding is available. */
export const EMPTY_CONVERSATION_SNAPSHOT: ConversationSnapshot = {
  views: { get: () => undefined, grouped: () => undefined },
  activeTargets: new Set(),
}

/** Shell phase derived from Session lifecycle and registered target activity. */
export type ConversationPhase = 'blank' | 'engaging' | 'active'

/**
 * Resolve the shell phase without adding Conversation data to the Session snapshot.
 * @param session - current Session lifecycle state.
 * @param conversation - current target-neutral Conversation state.
 * @returns the phase used by the header, View ring, and composer layout.
 */
export function conversationPhase(
  session: SessionSnapshot,
  conversation: ConversationSnapshot,
): ConversationPhase {
  const active = conversation.activeTargets.size > 0
    || (!session.blank && !session.awaitingFirstTurn)
    || session.running
  return active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
}

/** Presentation phase of one embedded conversation occurrence. */
export type EmbeddedConversationPhase = 'settling' | 'hero' | 'active'

/** Facts an embedded occurrence reads beyond the two snapshots. */
export interface EmbeddedConversationFacts {
  /** The session-list row's blank flag, absent before the list projects the row. */
  readonly summaryBlank: boolean | undefined
}

/**
 * Resolve the embedded occurrence phase shared by every embedded conversation host.
 * @param session - current Session lifecycle state.
 * @param conversation - current target-neutral Conversation state.
 * @param facts - the session-list blank flag for this session.
 * @returns settling while the first read is pending, hero on an empty open session, otherwise active.
 */
export function embeddedConversationPhase(
  session: SessionSnapshot,
  conversation: ConversationSnapshot,
  facts: EmbeddedConversationFacts,
): EmbeddedConversationPhase {
  const shellPhase = conversationPhase(session, conversation)
  const parentAvailabilityPending = session.subagent?.address.mode === 'continuable'
    && session.subagent.parentAvailable === undefined
  const settling = (shellPhase === 'blank' && session.openState === 'loading' && facts.summaryBlank !== true)
    || parentAvailabilityPending
  const hero = shellPhase === 'blank' && (session.openState === 'open' || facts.summaryBlank === true)
  return settling ? 'settling' : hero ? 'hero' : 'active'
}
