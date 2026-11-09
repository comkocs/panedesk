/**
 * Extraction of the Claude Code `## Compact Instructions` sections from the
 * workspace CLAUDE.md chain, appended to the compaction prompt verbatim.
 *
 * @module @panedesk/dsh-agent-instructions/compact
 */

import { join, resolve } from 'node:path'
import type { FileSystem } from '@panedesk/dsh-fs'
import { ancestorChain, findProjectRoot, readInstructionFile } from './files.ts'

/** Default source byte cap for one compact-instruction candidate, shared with {@link readInstructionFile} callers. */
const DEFAULT_COMPACT_SOURCE_MAX_BYTES = 1_048_576

/** Same-directory candidates whose Compact Instructions sections join the compaction prompt. */
const COMPACT_INSTRUCTION_CANDIDATES = ['CLAUDE.md', 'CLAUDE.local.md'] as const

/** Heading that opens the compact-instruction section. */
const COMPACT_INSTRUCTIONS_HEADING = '## Compact Instructions'

/**
 * Extract the `## Compact Instructions` section from one instruction document.
 * The section runs from its heading to the next ATX heading or the end of the
 * file, whichever comes first.
 * @param content - instruction document text.
 * @returns the trimmed section including its heading, or undefined without one.
 */
export function extractCompactInstructions(content: string): string | undefined {
  const lines = content.split('\n')
  const start = lines.indexOf(COMPACT_INSTRUCTIONS_HEADING)
  if (start < 0) return undefined
  const section: string[] = []
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) break
    if (index !== start && /^#{1,6}\s/u.test(line)) break
    section.push(line)
  }
  const text = section.join('\n').trim()
  return text.length === 0 ? undefined : text
}

/**
 * Collect the Compact Instructions sections of the root-to-cwd CLAUDE.md chain
 * for the compaction prompt, broadest directory first.
 * @param options - cwd, optional root markers, per-file source cap, and cancellation.
 * @param fileSystem - optional provider used instead of host filesystem reads.
 * @returns the joined sections, or undefined when no candidate carries one.
 * @throws the original root-marker metadata error or cancellation reason when
 * discovery cannot identify the project root.
 */
export async function collectCompactInstructions(
  options: { cwd: string; projectRootMarkers?: readonly string[]; maxSourceBytes?: number; signal?: AbortSignal },
  fileSystem?: FileSystem,
): Promise<string | undefined> {
  const cwd = resolve(options.cwd)
  const projectRoot = await findProjectRoot(cwd, options.projectRootMarkers ?? ['.git'], fileSystem, options.signal)
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_COMPACT_SOURCE_MAX_BYTES
  const sections: string[] = []
  for (const directory of ancestorChain(projectRoot, cwd)) {
    for (const candidate of COMPACT_INSTRUCTION_CANDIDATES) {
      const content = await readInstructionFile(
        join(directory, candidate),
        maxSourceBytes,
        fileSystem,
        options.signal,
      )
      if (content === undefined) continue
      const section = extractCompactInstructions(content)
      if (section !== undefined) sections.push(section)
    }
  }
  return sections.length === 0 ? undefined : sections.join('\n\n')
}
