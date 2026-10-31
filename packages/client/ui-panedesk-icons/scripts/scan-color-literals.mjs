#!/usr/bin/env node
/**
 * Color-literal scan over this package's sources: glyph components and the
 * token table must carry no hardcoded color values. The only sanctioned
 * literal colors live in the upstream theme's stylesheets; this package
 * references them as CSS custom-property names. `src/tokens.ts` records
 * upstream *names* (not values) and is exempt by filename; everything else
 * under src/ is scanned.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const exempt = new Set(['tokens.ts'])
const literalPattern = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|\bblueviolet\b|\bcornflowerblue\b/

/** Collect scanned files recursively, skipping the exempt token table. */
function collect(dir) {
  const files = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) files.push(...collect(full))
    else files.push(full)
  }
  return files
}

const sources = collect(join(root, 'src')).filter(file => !exempt.has(file.split('/').pop()))
const violations = []
for (const file of sources) {
  const text = readFileSync(file, 'utf8')
  for (const [index, line] of text.split('\n').entries()) {
    if (literalPattern.test(line)) violations.push(`${file}:${index + 1}: ${line.trim()}`)
  }
}

if (violations.length > 0) {
  console.error(`scan-color-literals: ${violations.length} hardcoded color literal(s)`)
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
console.log(`scan-color-literals: clean (${sources.length} scanned source file(s), token table exempt)`)
