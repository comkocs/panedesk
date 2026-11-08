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
  /** Ids checked by default: the newest two in each model family. */
  readonly checked: ReadonlySet<string>
  /** Which fact decided the order. */
  readonly orderBasis: RecognizeOrderBasis
}

/**
 * Order one listing and check the newest two models per family.
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
  const families = new Map<string, LlmDiscoveredModel[]>()
  for (const model of models) {
    const family = model.id.toLowerCase().split(/[^a-z0-9]+/).filter(part => part && !/^\d+$/.test(part) && part !== 'latest' && part !== 'preview').join('-')
    const group = families.get(family) ?? []
    group.push(model)
    families.set(family, group)
  }
  const checked = new Set<string>()
  for (const group of families.values()) {
    group.sort((left, right) => {
      if (left.createdAt !== undefined || right.createdAt !== undefined) {
        return (right.createdAt ?? 0) - (left.createdAt ?? 0)
      }
      const a = left.id.match(/\d+/g)?.map(Number) ?? []
      const b = right.id.match(/\d+/g)?.map(Number) ?? []
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const difference = (b[i] ?? 0) - (a[i] ?? 0)
        if (difference !== 0) return difference
      }
      return 0
    })
    for (const model of group.slice(0, 2)) checked.add(model.id)
  }
  return {
    models: ordered,
    checked,
    orderBasis: dated ? 'createdAt' : 'server',
  }
}
