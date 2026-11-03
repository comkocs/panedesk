/** Resolve executable inputs from the running host, never from workspace directory conventions. */
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@panedesk/cordis'
import type {} from '@panedesk/dsh-app-boot'
import type {} from '@panedesk/dsh-hmr'
import type {} from '@panedesk/dsh-client-modules'
import { canonicalPath } from '@panedesk/dsh-sandbox'
import { resolveDshHome } from '@panedesk/dsh-home-paths'

/**
 * Collect current profile, loaded plugin, and active watcher directories.
 * @param ctx - The running host's service context.
 * @param workspace - Actual write root; omission collects host inputs without preparing state directories.
 * @returns Protected path spellings and canonical targets; unrelated projects are not inspected.
 */
export function resolveProtectedPaths(ctx: Context, workspace?: string): string[] {
  const paths = new Set<string>()
  const add = (path: string): void => {
    paths.add(resolve(path))
    paths.add(canonicalPath(resolve(path)))
  }
  const addState = (home: string): void => {
    const directory = join(home, 'windows-workspace-write')
    add(directory)
    if (workspace === undefined || process.platform === 'win32') return
    const root = canonicalPath(workspace)
    const target = canonicalPath(directory)
    const suffix = relative(root, target)
    if (suffix === '' || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) return
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    add(join(root, suffix.split(sep)[0]!))
  }
  addState(resolveDshHome())
  const profile = ctx.get('profileContext')
  if (profile !== undefined) {
    add(join(profile.home, 'cordis.patch.yml'))
    addState(profile.home)
    add(profile.dir)
    add(profile.patchPath)
    for (const path of profile.bundleInputPaths ?? []) add(path)
    for (const path of profile.overlayPaths ?? []) add(path)
  }
  const packages = ctx.get('pluginPackages')
  const loader = ctx.get('loader')
  if (loader !== undefined) {
    for (const entry of loader.entries()) {
      if (entry.options.group === true || typeof entry.options.name !== 'string') continue
      // Imported modules can retain process effects even after their entry is disabled.
      if (entry.disabled && entry.moduleNamespace === undefined) continue
      const base = entry.parent.tree.ctx.baseUrl
      const name = entry.options.name
      if (name.startsWith('cordis:')) continue
      if (base === undefined && !name.startsWith('file:') && !isAbsolute(name)) {
        throw new Error('Cannot resolve protected plugin path without its Loader base URL')
      }
      const owner = base === undefined ? undefined : packages?.packageOf(name, base)
      if (owner !== undefined) add(owner.dir)
      else if (name.startsWith('file:') || name.startsWith('.') || isAbsolute(name)) {
        const url = isAbsolute(name) ? pathToFileURL(name) : new URL(name, base)
        if (url.protocol === 'file:') add(dirname(fileURLToPath(url)))
      }
    }
  }
  const hmr = ctx.get('hmr')
  if (hmr !== undefined) {
    for (const root of hmr.config.root) add(resolve(hmr.baseDir, root))
    for (const path of hmr.configurationPaths()) add(path)
  }
  const modules = ctx.get('clientModules')
  if (modules !== undefined) {
    for (const entry of modules.graph().entries) {
      const artifact = modules.artifactBaseline(entry.id)
      if (artifact !== undefined) add(dirname(artifact.path))
    }
  }
  return [...paths].sort()
}
