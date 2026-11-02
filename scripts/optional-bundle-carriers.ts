/**
 * Optional bundles the launcher ships switched off may be carried by a separately installed package
 * instead of the launcher itself. Only the launcher's optional peer edge to one of these carriers is
 * outside the default installation graph; the carrier's own optional bundles are installed beside the
 * product, not required by it.
 *
 * Panedesk fork divergence: the carrier is @panedesk/full. Manually reconcile this set and
 * OPTIONAL_BUNDLES with upstream during merges.
 */

/** Packages whose optional-peer edge from the launcher carries the launcher's optional bundles. */
export const OPTIONAL_BUNDLE_CARRIERS: ReadonlySet<string> = new Set(['@panedesk/full'])

/**
 * Whether `name` is a declared optional-bundle carrier reached through an optional peer edge.
 * @param name - dependency package name.
 * @param optionalPeer - true when the edge is an optional peer dependency.
 * @returns whether the edge leaves the default installation graph.
 */
export function isOptionalBundleCarrierEdge(name: string, optionalPeer: boolean): boolean {
  return optionalPeer && OPTIONAL_BUNDLE_CARRIERS.has(name)
}
