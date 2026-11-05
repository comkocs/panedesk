/** Structural validation for host-mutated authoritative trees, independent of their bytes. */
import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { en, zh } from './input-integrity-locales.ts'

function absent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function within(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

/**
 * Validate one mutable tree without capturing content or retaining a baseline.
 * Windows retains sandbox write exclusion without a structural check.
 * @param root - Exact canonical-home tree spelling, never a resolved tree alias.
 * @returns Cooperative traversal; throws bilingual diagnostics on unsafe structure.
 */
export function* checkAuthoritativeTree(root: string): Generator<void, void> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return
  const reject = (path: string): never => { throw new Error(`${en.authorityStructureFailed} / ${zh.authorityStructureFailed} ${path}`) }
  const uid = process.getuid?.()
  if (uid === undefined) return reject(root)
  const stat = (path: string) => {
    try { return lstatSync(path, { bigint: true }) } catch (error) {
      // Host lock release and atomic cache replacement can remove an enumerated name.
      if (absent(error)) return undefined
      throw error
    }
  }
  const initial = stat(root)
  if (initial === undefined) return
  if (!initial.isDirectory() || realpathSync(root) !== root) reject(root)
  const links = new Map<string, { paths: string[]; dev: bigint; ino: bigint }>()
  const pending = [root]
  for (const path of pending) {
    const entry = stat(path)
    if (entry === undefined) continue
    if (entry.uid !== BigInt(uid) || (!entry.isSymbolicLink() && (entry.mode & 0o022n) !== 0n)) reject(path)
    if (entry.isSymbolicLink()) {
      // Link mode bits are not write permissions on POSIX; the target is checked in-tree.
      let target: string
      try { target = realpathSync(path) } catch (error) {
        if (absent(error)) reject(path)
        throw error
      }
      if (!within(root, target)) reject(path)
    } else if (entry.isDirectory()) {
      let names: string[]
      try { names = readdirSync(path) } catch (error) {
        if (absent(error)) continue
        throw error
      }
      pending.push(...names.map(name => join(path, name)))
    } else if (entry.isFile()) {
      const key = `${entry.dev}:${entry.ino}`
      const previous = links.get(key)
      if (previous === undefined) links.set(key, { paths: [path], dev: entry.dev, ino: entry.ino })
      else previous.paths.push(path)
    } else reject(path)
    yield
  }
  for (const { paths, dev, ino } of links.values()) {
    const live = paths.map(path => ({ path, entry: stat(path) }))
      .filter(value => value.entry?.dev === dev && value.entry.ino === ino)
    for (const { path, entry } of live) {
      if (entry !== undefined && entry.nlink !== BigInt(live.length)) reject(path)
    }
  }
  const final = stat(root)
  if (final !== undefined && (!final.isDirectory() || final.dev !== initial.dev || final.ino !== initial.ino
    || final.uid !== BigInt(uid) || (final.mode & 0o022n) !== 0n || realpathSync(root) !== root)) reject(root)
}
