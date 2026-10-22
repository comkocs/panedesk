/** Instruction observations for subscriptions; these events never reload model-visible instructions. */
import type { Agent } from '@panedesk/dsh-agent'
import type { Scoped } from '@panedesk/dsh-scope'

/** Hash of the exact loaded bytes, not normalized rendering or a file-touch guess. */
export interface InstructionObservation {
  readonly path: string
  readonly hash: string
  /** Empty hash is not evidence when a version-qualified raw read is unavailable. */
  readonly evidence?: { readonly status: 'available' } | {
    readonly status: 'unavailable'
    readonly reason: 'version-mismatch' | 'read-unavailable' | 'version-unavailable'
  }
  /** Startup admission, rather than a later upstream instruction refresh. */
  readonly baseline?: boolean
}

declare module '@panedesk/cordis' {
  interface Events {
    /**
     * Wait for successful tool-result observations before checking subscriptions.
     * @mode serial
     * @param payload.agent - agent whose pending byte reads must settle.
     */
    'instructions/writes-settling'(this: Scoped<Agent>, payload: { agent: Agent }): Promise<void> | void
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
