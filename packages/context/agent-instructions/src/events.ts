/** Instruction observations for subscriptions; these events never reload model-visible instructions. */
import type { Agent } from '@panedesk/dsh-agent'
import type { Scoped } from '@panedesk/dsh-scope'

/** Hash of the exact loaded bytes, not normalized rendering or a file-touch guess. */
export interface InstructionObservation {
  readonly path: string
  readonly hash: string
}

declare module '@panedesk/cordis' {
  interface Events {
    /**
     * Successful instruction admission for this agent; descendants publish their own loaded sets.
     * @mode emit
     * @param payload.agent - agent that actually loaded the files.
     * @param payload.files - exact admitted paths and byte hashes, excluding unreadable files.
     */
    'instructions/loaded'(this: Scoped<Agent>, payload: { agent: Agent; files: readonly InstructionObservation[] }): void
    /**
     * Successful self-write evidence; reads, failed writes, and ancestor writes do not qualify.
     * @mode emit
     * @param payload.agent - agent whose successful write produced these bytes.
     * @param payload.file - written path and post-write hash used for exact self-write suppression.
     */
    'instructions/written'(this: Scoped<Agent>, payload: { agent: Agent; file: InstructionObservation }): void
  }
}
