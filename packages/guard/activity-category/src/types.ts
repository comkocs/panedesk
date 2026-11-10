/** Task-scoped activity query values shared with display and verification consumers. */
import type { ActivityCategory } from './categories.ts'
import type { ActivityClassification } from './classify.ts'
export type { ActivityCategory } from './categories.ts'
export type { ActivityRule, ActivityClassification } from './classify.ts'

/** One category's operation count and observed execution time, including active operations. */
export interface ActivityTotal {
  category: ActivityCategory
  count: number
  durationMs: number
  /** Primary-category time is the denominator; the script tag overlaps and is not added again. */
  share: number
}

/** Most recently started operation, retained after it finishes. */
export interface CurrentActivity extends ActivityClassification {
  startedAt: number
  durationMs: number
  active: boolean
}

/** Latest task for a session; null queries mean no observed activity, not zero work. */
export interface ActivitySummary {
  taskId: string
  startedAt: number
  totals: ActivityTotal[]
  totalMs: number
  current: CurrentActivity | null
}
