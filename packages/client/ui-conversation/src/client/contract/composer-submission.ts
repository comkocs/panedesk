/** Composer submission vocabulary shared by the input and settings domains. */

export type { BusyEnterBehavior } from '../../submission-settings.ts'

/** Delivery mode requested for one ordinary composer message; next-step waits for tools without interrupting. */
export type InputSubmitMode = 'queue' | 'steer' | 'next-step'

/** Keyboard gesture whose delivery mode the submission policy resolves. */
export type ComposerSubmitGesture = 'enter' | 'accelerated'

/** Session facts captured when a message submission starts, before asynchronous command arbitration. */
export interface MessageSubmissionState {
  readonly sessionId?: import('@panedesk/dsh-session/types').SessionId
  readonly model?: { readonly provider: string; readonly name: string; readonly effort?: string }
  readonly runMode: 'default' | 'plan' | 'goal'
  readonly running: boolean
}

/** Immutable occurrence and delivery intent carried by one composer attempt. */
export interface MessageSubmission {
  readonly timestamp: number
  readonly source?: 'click' | 'enter'
  readonly mode: InputSubmitMode
  readonly state?: MessageSubmissionState
}
