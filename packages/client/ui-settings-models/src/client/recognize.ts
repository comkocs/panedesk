/**
 * Default selection for the provider card's "Recognize models" action.
 * Creation times win when any advertised model discloses one; otherwise the
 * server's own order is kept and named as the basis.
 */
import type { LlmDiscoveredModel } from '@panedesk/dsh-api-remotes/client'

/** How a recognized list was ordered. */
export type RecognizeOrderBasis = 'createdAt' | 'server'

/** One recognized listing plus the ids that start checked. */
export interface RecognizedSelection {
  /** Models in display order. */
  readonly models: readonly LlmDiscoveredModel[]
  /** Ids checked by default: the three newest, or the first three. */
  readonly checked: ReadonlySet<string>
  /** Which fact decided the order. */
  readonly orderBasis: RecognizeOrderBasis
}

/** How many models start checked. */
const DEFAULT_CHECKED = 3

/**
 * Order one listing and check its default three.
 * @param models - models the endpoint advertised, in its own order.
 * @returns the display order, the default checks, and the basis.
 */
export function defaultRecognizedSelection(
  models: readonly LlmDiscoveredModel[],
): RecognizedSelection {
  const dated = models.some(model => model.createdAt !== undefined)
  const ordered = dated
    ? [...models].sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    : [...models]
  return {
    models: ordered,
    checked: new Set(ordered.slice(0, DEFAULT_CHECKED).map(model => model.id)),
    orderBasis: dated ? 'createdAt' : 'server',
  }
}
