/** Project trace records shared by Host consumers and generated remote clients. */
import type { Branded } from '@panedesk/dsh-brand'
import type { SessionId } from '@panedesk/dsh-session/types'
import type { WorkspaceId } from '@panedesk/dsh-workspace/types'

/** Stable identity of one home-owned project database. */
export type ProjectId = Branded<'TraceProjectId'>
/** Database-local item number. */
export type ItemId = number
/** Stable decision identity within one project. */
export type DecisionId = Branded<'TraceDecisionId'>
/** Stable reference identity within one project. */
export type ReferenceId = Branded<'TraceReferenceId'>
/** Automatic attribution; null means no session or model participated. */
export interface TraceSource {
  actor: 'user' | 'planner' | 'executor' | 'subagent'
  sessionId: SessionId | null
  model: string | null
  time: number
}
/** Workspace switches live outside model-editable settings. */
export interface TraceStatus {
  projectId: ProjectId | null
  enabled: boolean
  strict: boolean
  plannerSessionId: SessionId | null
}
/** Workspace selector used by every operation; sessionId identifies the UI's window, not caller authority. */
export interface WorkspaceRequest { workspaceId: WorkspaceId; sessionId?: SessionId }
/** Durable item and its creator. */
export interface TraceItem { id: ItemId; title: string; status: 'open' | 'closed' | 'void'; source: TraceSource }
/** Timeline entry; JSON payload may retain up to 4000 UTF-16 code units of visible reply text. */
export interface TraceEvent {
  id: number; itemId: ItemId | null; type: string; sessionId: SessionId | null
  seqStart: number | null; seqEnd: number | null; source: TraceSource; payload: string; dedupKey: string
}
/** Cursor is the last returned event number; null means this page exhausts the current selection. */
export interface TimelinePage { events: TraceEvent[]; nextCursor: number | null; refs: TraceReference[] }
/** Immutable reference; session sequence ranges are inclusive. */
export type TraceReference = {
  id: ReferenceId; eventId: number; kind: 'session-slice' | 'attachment' | 'change'
  sessionId: SessionId | null; seqStart: number | null; seqEnd: number | null
  path: string | null; beforeHash: string | null; afterHash: string | null
  summary: string; diffFile: string | null
}
/** One immutable decision revision. Active selection lives separately on the decision row. */
export interface DecisionRevision {
  id: DecisionId; revision: number; itemId: ItemId | null; title: string; body: string
  status: 'active' | 'proposed' | 'rejected' | 'reverted'; source: TraceSource
}
/** Selecting an item never changes the session's working directory. */
export interface ItemRequest extends WorkspaceRequest { itemId: ItemId }
/** Null selects unassigned events newest first; an item selects its events oldest first. */
export interface TimelineRequest extends WorkspaceRequest { itemId: ItemId | null; cursor?: number; limit?: number }
/** Existing decision id creates another revision; omission creates a decision. */
export interface DecisionWriteRequest extends WorkspaceRequest { decisionId?: DecisionId; itemId: ItemId | null; title: string; body: string }
/** The exact proposal revision prevents confirmation of a different later proposal. */
export interface DecisionRevisionRequest extends WorkspaceRequest { decisionId: DecisionId; revision: number }
/** Session slices contain a JSON reply string or event array; attachment paths are not dereferenced. */
export interface ReferenceContent { reference: TraceReference; text: string }
