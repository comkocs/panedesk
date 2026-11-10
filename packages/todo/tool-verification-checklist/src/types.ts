/**
 * Pure types of the verification checklist: the one home of the
 * `verificationChecklists` projection-key declaration plus its payload types.
 *
 * @module @panedesk/dsh-tool-verification-checklist/types
 */

/**
 * Activity category ids the checklist may name. The strings match the activity
 * category ids exactly; this package keeps its own copy so the tool stays free
 * of the activity service.
 */
export const VERIFICATION_CHECKLIST_CATEGORIES = [
  'write', 'read', 'build', 'test-focused', 'test-full', 'mutation',
  'client', 'ci', 'script', 'wait', 'model', 'other',
] as const

/** One activity category id a checklist item can name. */
export type VerificationChecklistCategory = typeof VERIFICATION_CHECKLIST_CATEGORIES[number]

/** One planned check inside a requirement's checklist. */
export interface VerificationChecklistItem {
  /** Activity category the check belongs to. */
  category: VerificationChecklistCategory
  /** One short line describing the check. */
  note: string
  /** Estimated minutes for the check. */
  minutes: number
}

/** One requirement's checklist, replaced wholesale when the same title is submitted again. */
export interface VerificationChecklistSubmission {
  /** One sentence naming the requirement. */
  title: string
  /** Planned checks; empty when the requirement has nothing to verify. */
  items: VerificationChecklistItem[]
}

declare module '@panedesk/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whole checklist list for one session; the latest write wins on replay.
     * @mode replay
     * @param checklists - every requirement's checklist after this submission.
     */
    'verification/write': { checklists: VerificationChecklistSubmission[] }
  }
}

declare module '@panedesk/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Latest whole checklist list; empty before the first submission. */
    verificationChecklists: VerificationChecklistSubmission[]
  }
  interface SessionProjectionMap {
    /**
     * The session's current verification checklists (the latest `verification/write`
     * snapshot). Whole-value rule: every write carries the complete list, so the
     * fold is last-wins and a later turn does not clear it.
     */
    verificationChecklists: VerificationChecklistSubmission[]
  }
}
