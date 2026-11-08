/** Default recognition selects one model per family, by numeric version then creation time. */
import type { LlmDiscoveredModel } from '@panedesk/dsh-api-remotes/client'

/** How a recognized list was ordered. */
export type RecognizeOrderBasis = 'version' | 'createdAt' | 'server'

/** One recognized listing plus the ids that start checked. */
export interface RecognizedSelection {
  /** Models in display order. */
  readonly models: readonly LlmDiscoveredModel[]
  /** Ids checked by default: the newest model in each family. */
  readonly checked: ReadonlySet<string>
  /** Which fact decided the order. */
  readonly orderBasis: RecognizeOrderBasis
}

/** Normalize compact snapshot dates so they compare like hyphenated dates. */
function versionOf(id: string): number[] {
  return id.replace(/\b(\d{4})(\d{2})(\d{2})\b/g, '$1-$2-$3').match(/\d+/g)?.map(Number) ?? []
}

/** Compare version segments first; equal versions use the reported creation time. */
function newestFirst(left: LlmDiscoveredModel, right: LlmDiscoveredModel): number {
  const a = versionOf(left.id)
  const b = versionOf(right.id)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (b[i] ?? 0) - (a[i] ?? 0)
    if (difference !== 0) return difference
  }
  return (right.createdAt ?? 0) - (left.createdAt ?? 0)
}

/**
 * Order one listing and check the newest model per family, retaining variant words.
 * @param models - models the endpoint advertised, in its own order.
 * @returns the display order, the default checks, and the basis.
 */
export function defaultRecognizedSelection(
  models: readonly LlmDiscoveredModel[],
): RecognizedSelection {
  const versioned = models.some(model => /\d/.test(model.id))
  const dated = models.some(model => model.createdAt !== undefined)
  const ordered = [...models].sort(newestFirst)
  const families = new Set<string>()
  const checked = new Set<string>()
  for (const model of ordered) {
    const family = model.id.toLowerCase().replace(/\d+/g, '').split(/[^a-z]+/).filter(Boolean).join('-')
    if (families.has(family)) continue
    families.add(family)
    checked.add(model.id)
  }
  return {
    models: ordered,
    checked,
    orderBasis: versioned ? 'version' : dated ? 'createdAt' : 'server',
  }
}
