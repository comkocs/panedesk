#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, lstatSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, relative, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const mapping = JSON.parse(readFileSync(new URL('./mapping.json', import.meta.url), 'utf8'))
const rules = Object.values(mapping.groups).flat()
const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const counts = new Map(rules.map(rule => [rule.id, 0]))
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })

function excluded(path) {
  return path.startsWith('scripts/panedesk/rename/') || path === 'docs/改名待改清单.md'
    || path.startsWith('.agents/notes/archived/')
    || ['LICENSE', 'THIRD_PARTY_NOTICES.md'].includes(basename(path))
    || basename(path).startsWith('BRAND_GUIDELINES')
}

function transform(text, path) {
  const preservedLines = mapping.preservedLines.filter(line => line.path === path)
  for (const rule of rules) {
    if (rule.files && !rule.files.includes(path)) continue
    if (rule.pathPattern && !new RegExp(rule.pathPattern).test(path)) continue
    const pattern = rule.literal === undefined
      ? new RegExp(rule.pattern, rule.flags ?? 'g')
      : new RegExp(rule.literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
    text = text.replace(pattern, (...args) => {
      const match = args[0]
      const offset = args.at(-2)
      const source = args.at(-1)
      if (preservedLines.length) {
        const start = source.lastIndexOf('\n', offset - 1) + 1
        const end = source.indexOf('\n', offset)
        const line = source.slice(start, end < 0 ? undefined : end)
        if (preservedLines.some(entry => line.includes(entry.includes))) return match
      }
      // Office package paths can split the scope and package into separate arguments.
      if (rule.id === 'A3') {
        const end = source.indexOf('\n', offset)
        const suffix = source.slice(offset + match.length, end < 0 ? undefined : end)
        if (mapping.officeScopeSuffixes.some(suffixPattern => new RegExp(suffixPattern).test(suffix))) return match
      }
      counts.set(rule.id, counts.get(rule.id) + 1)
      return rule.replacement
    })
  }
  return text
}

function textFile(path) {
  const full = resolve(root, path)
  if (!lstatSync(full).isFile()) return undefined
  const bytes = readFileSync(full)
  try { return decoder.decode(bytes) } catch { return undefined }
}

function report() {
  for (const rule of rules) console.log(`${rule.id}\t${counts.get(rule.id)}`)
}

function patch(input, output) {
  let path
  let skip = false
  const result = decoder.decode(readFileSync(input)).split(/(?<=\n)/).map(line => {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+) b\/(.+)\r?\n?$/.exec(line)
      if (!match) throw new Error('Unsupported quoted or non-Git diff header')
      path = match[2]
      skip = excluded(match[1]) || excluded(path)
    } else if (line.startsWith('+++ ') && !line.startsWith('+++ /dev/null')) {
      path = line.slice(4).split('\t')[0].trimEnd().replace(/^b\//, '')
      skip = excluded(path)
    }
    if (skip || path === undefined) return line
    // Preserve hunk coordinates: every mapping is line-count preserving.
    if (/^(?:diff --git |--- |\+\+\+ |rename (?:from|to) |[ +\-])/.test(line)) return transform(line, path)
    return line
  }).join('')
  writeFileSync(output, result)
  report()
}

function tree(apply) {
  if (resolve(process.cwd()) !== root) throw new Error('Run from the repository root')
  const files = git('ls-files', '-z').split('\0').filter(path => path && !excluded(path))
  const changes = []
  for (const path of files) {
    const before = textFile(path)
    if (before === undefined) continue
    const after = transform(before, path)
    if (after !== before) changes.push({ path, before, after })
  }
  // B1/B2 transform file contents; this fixed rule also moves tracked directory
  // segments, without rewriting legacy-home import code or similarly named files.
  const moves = files.flatMap(path => {
    const parts = path.split('/')
    const target = parts.map((part, index) => index < parts.length - 1 && part === '.dsh' ? '.panedesk' : part).join('/')
    return target === path ? [] : [{ path, target }]
  })
  report()
  for (const { path, target } of moves) console.log(`B2-path\t${path}\t${target}`)
  console.log(`B2-path\t${moves.length}`)
  if (!apply) {
    process.exitCode = changes.length === 0 && moves.length === 0 ? 0 : 1
    return
  }
  for (const { path, target } of moves) {
    if (!lstatSync(resolve(root, path)).isFile()) throw new Error(`Not a regular tracked file: ${path}`)
    if (existsSync(resolve(root, target))) throw new Error(`Rename destination exists: ${target}`)
  }
  // A path-only replay on an already renamed tree has no D substitutions to validate.
  const pathOnly = changes.length === 0 && moves.length > 0
  // Validate the entire input before the first write; drift must not leave a partial rename.
  const drift = pathOnly ? [] : rules.filter(rule => rule.expected !== undefined && counts.get(rule.id) !== rule.expected)
  if (drift.length) throw new Error(drift.map(rule => `${rule.id}: expected ${rule.expected}, got ${counts.get(rule.id)}`).join('\n'))
  const generators = [
    ['scripts/gen-tsconfig-paths.ts', 'tsconfig.base.json'],
    ['scripts/gen-dependency-catalog.ts', 'docs/dependency-catalog.json'],
  ]
  const originals = pathOnly ? [] : generators.map(([, path]) => [path, readFileSync(resolve(root, path))])
  const moved = []
  try {
    for (const { path, after } of changes) writeFileSync(resolve(root, path), after)
    for (const [script] of pathOnly ? [] : generators) {
      execFileSync(process.execPath, [script], { cwd: root, stdio: 'inherit' })
    }
    for (const move of moves) {
      mkdirSync(dirname(resolve(root, move.target)), { recursive: true })
      git('mv', '--', move.path, move.target)
      moved.push(move)
    }
  } catch (error) {
    for (const { path, target } of moved.reverse()) git('mv', '--', target, path)
    for (const { path, before } of changes) writeFileSync(resolve(root, path), before)
    for (const [path, bytes] of originals) writeFileSync(resolve(root, path), bytes)
    throw error
  }
  console.log(`Renamed ${changes.length} tracked text files and moved ${moves.length} tracked paths; lockfile received text substitutions only.`)
}

const args = process.argv.slice(2)
try {
  if (args.length === 1 && args[0] === '--apply') tree(true)
  else if (args.length === 1 && args[0] === '--check') tree(false)
  else if (args.length === 3 && args[0] === '--patch') {
    if (resolve(args[1]) === resolve(args[2])) throw new Error('Patch input and output must differ')
    patch(args[1], args[2])
  } else throw new Error('Usage: node scripts/panedesk/rename/rename.mjs --apply | --check | --patch INPUT.diff OUTPUT.diff')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
