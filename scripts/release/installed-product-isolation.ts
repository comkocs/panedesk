/**
 * Experimental-package isolation for the installed default product's dependency graph.
 *
 * Panedesk fork divergence: optional bundles may be carried by @panedesk/full instead of apps/cli.
 * Only the launcher's optional peer edge to that carrier is outside the default installation graph;
 * default runtime dependencies, imports, and compositions must still exclude experimental packages.
 * Manually reconcile this exception and OPTIONAL_BUNDLES with upstream during merges.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { hasExperimentalPackageReference } from '../experimental-package-policy.ts'
import { isOptionalBundleCarrierEdge } from '../optional-bundle-carriers.ts'
import { OPTIONAL_BUNDLES } from '../../packages/boot/app-boot/src/profile.ts'

interface InstalledManifest {
  name: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

/**
 * Reject experimental dependencies reachable from one installed product entry.
 * Other packages installed beside the entry and development dependencies do not join its graph.
 * @param directory - installed entry package directory.
 * @returns number of distinct installed packages visited.
 */
export function verifyInstalledProductIsolation(directory: string, optionalBundles: readonly string[] = OPTIONAL_BUNDLES): number {
  const visited = new Set<string>()
  const queue = [{ directory, chain: [] as string[], optionalPeer: false }]
  for (const item of queue) {
    const canonical = realpathSync(item.directory)
    if (visited.has(canonical)) continue
    visited.add(canonical)
    const manifest = JSON.parse(readFileSync(join(canonical, 'package.json'), 'utf8')) as InstalledManifest
    const chain = [...item.chain, manifest.name]
    rejectExperimental(manifest.name, chain)
    // The bundles the entry package ships switched off are installed beside the product, not required by it,
    // whether the entry depends on them directly or reaches a declared carrier through its own optional peer edge.
    const offered = item.chain.length === 0
      || (item.chain.length === 1 && isOptionalBundleCarrierEdge(manifest.name, item.optionalPeer))
      ? new Set(optionalBundles) : new Set<string>()
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) {
        if (section === 'dependencies' && offered.has(name)) {
          if (installedPackage(canonical, name) === undefined) throw new Error(`optional bundle is missing: ${[...chain, name].join(' -> ')}`)
          continue
        }
        rejectExperimental(name, [...chain, name])
        if (range.startsWith('npm:')) {
          rejectExperimental(range.slice(4), [...chain, `${name} (${range})`])
        }
        const dependency = installedPackage(canonical, name)
        if (dependency === undefined) {
          if (section === 'optionalDependencies'
            || Object.hasOwn(manifest.optionalDependencies ?? {}, name)
            || section === 'peerDependencies' && manifest.peerDependenciesMeta?.[name]?.optional === true) continue
          throw new Error(`default product dependency is missing: ${[...chain, name].join(' -> ')}`)
        }
        queue.push({
          directory: dependency,
          chain,
          optionalPeer: section === 'peerDependencies' && manifest.peerDependenciesMeta?.[name]?.optional === true,
        })
      }
    }
  }
  return visited.size
}

function rejectExperimental(name: string, chain: readonly string[]): void {
  if (hasExperimentalPackageReference(name)) {
    throw new Error(`default product includes an experimental package: ${chain.join(' -> ')}`)
  }
}

/** Resolve a dependency directory through the installed package's ancestor node_modules. */
function installedPackage(from: string, name: string): string | undefined {
  const resolver = createRequire(join(from, 'package.json'))
  for (const directory of resolver.resolve.paths(name) ?? []) {
    const candidate = join(directory, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}
