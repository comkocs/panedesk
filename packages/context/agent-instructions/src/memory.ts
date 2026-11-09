/**
 * Claude Code per-project memory discovery: the `MEMORY.md` under
 * `~/.claude/projects/<encoded cwd>/memory` joins the workspace instruction
 * baseline for sessions opened in that working directory.
 *
 * @module @panedesk/dsh-agent-instructions/memory
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FileSystem } from '@panedesk/dsh-fs'
import { readInstructionFile } from './files.ts'
import type { LoadedInstructionFile } from './files.ts'

/** Memory file name inside the encoded project memory directory. */
export const CLAUDE_MEMORY_FILE = 'MEMORY.md'

/**
 * Encode a working directory the way Claude Code names its per-project
 * directory: every character that is not a letter or a digit becomes `-`
 * (`D:\proj\_x` → `D--proj--x`).
 * @param cwd - absolute session working directory.
 * @returns the encoded project directory name.
 */
export function encodeClaudeProjectsDirectory(cwd: string): string {
  return resolve(cwd).replace(/[^A-Za-z0-9]/gu, '-')
}

/**
 * Absolute memory paths for one working directory.
 * @param cwd - absolute session working directory.
 * @returns the project memory directory and the `MEMORY.md` file inside it.
 */
export function claudeMemoryPaths(cwd: string): { directory: string; file: string } {
  const directory = join(homedir(), '.claude', 'projects', encodeClaudeProjectsDirectory(cwd), 'memory')
  return { directory, file: join(directory, CLAUDE_MEMORY_FILE) }
}

/** A memory file load: the model-facing file plus its full directory path. */
export interface LoadedClaudeMemory {
  /** The `MEMORY.md` with its absolute path as the model-facing display path. */
  readonly file: LoadedInstructionFile
  /** Absolute memory directory the model reads and writes with the normal file tools. */
  readonly directory: string
}

/**
 * Load the Claude Code memory file for one working directory. A project
 * without the memory directory contributes nothing.
 * @param options - cwd, per-file source cap, and cancellation.
 * @param fileSystem - optional provider used instead of host filesystem reads.
 * @returns the loaded memory file and its directory, or undefined without one.
 */
export async function loadClaudeMemoryFile(
  options: { cwd: string; maxSourceBytes: number; signal?: AbortSignal },
  fileSystem?: FileSystem,
): Promise<LoadedClaudeMemory | undefined> {
  const { directory, file } = claudeMemoryPaths(options.cwd)
  const content = await readInstructionFile(file, options.maxSourceBytes, fileSystem, options.signal)
  if (content === undefined) return undefined
  return {
    directory,
    file: { absolutePath: file, displayPath: file, content },
  }
}
