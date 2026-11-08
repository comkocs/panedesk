/** Claude Code agent definitions (`~/.claude/agents`, `<workspace>/.claude/agents`) read as presets. */
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import type { Context } from '@panedesk/cordis'
import type { PresetDefinition } from './definition.ts'

/** Instruction plugin, addressed by its source file so the Loader can import it. */
const INSTRUCTION_PLUGIN = new URL('./claude-agent-instructions.ts', import.meta.url).href

/** Claude Code tool name to the Panedesk tool a running agent can call. */
const CLAUDE_TOOL_NAMES: Readonly<Record<string, string>> = {
  Read: 'read', Write: 'write', Edit: 'edit', MultiEdit: 'edit',
  Bash: 'bash', Grep: 'grep', Glob: 'glob',
  WebFetch: 'web_fetch', WebSearch: 'web_search',
  TodoWrite: 'todo_write', Skill: 'skill', AskUserQuestion: 'ask_user_question',
}

/** One parsed agent definition file. */
interface ClaudeAgentFile {
  readonly name: string
  readonly description: string
  readonly model: string
  readonly tools: readonly string[]
  readonly effort: string
  /** Body below the frontmatter: the agent's system instructions. */
  readonly body: string
}

/** Where the two definition trees live. Tests pass both; production reads the process home and cwd. */
export interface ClaudeAgentSources {
  readonly home?: string
  readonly workspace?: string
}

/** A definition turned into a preset. */
export interface ClaudeAgentPreset {
  /** Preset id, the definition's `name`. */
  readonly id: string
  readonly definition: PresetDefinition
  /** Claude Code tool names with no Panedesk tool; reported, never fatal. */
  readonly unmappedTools: readonly string[]
}

/** Split `---` frontmatter from the instruction body. */
function splitFrontmatter(text: string): { frontmatter: string; body: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  return match === null ? undefined : { frontmatter: match[1] ?? '', body: (match[2] ?? '').trim() }
}

/** Read one `*.md` agent file; undefined when it carries no usable frontmatter. */
async function readAgentFile(file: string): Promise<ClaudeAgentFile | undefined> {
  const split = splitFrontmatter(await readFile(file, 'utf8'))
  if (split === undefined) return undefined
  const parsed: unknown = load(split.frontmatter)
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const fields = parsed as Record<string, unknown>
  if (typeof fields['name'] !== 'string' || fields['name'].trim() === '') return undefined
  const tools = typeof fields['tools'] === 'string'
    ? fields['tools'].split(',').map(name => name.trim()).filter(name => name !== '')
    : []
  return {
    name: fields['name'].trim(),
    description: typeof fields['description'] === 'string' ? fields['description'].trim() : '',
    model: typeof fields['model'] === 'string' ? fields['model'].trim() : '',
    tools,
    effort: typeof fields['effort'] === 'string' && fields['effort'].trim() !== '' ? fields['effort'].trim() : 'high',
    body: split.body,
  }
}

/** Every `*.md` directly inside `dir`, read in lexical order; a missing directory contributes nothing. */
async function readAgentDir(dir: string): Promise<ClaudeAgentFile[]> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter(name => name.endsWith('.md')).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const files = await Promise.all(names.map(async name => readAgentFile(join(dir, name))))
  return files.filter((file): file is ClaudeAgentFile => file !== undefined)
}

/** Panedesk tool names for the listed Claude Code tools, plus the names that map to nothing. */
function mapTools(tools: readonly string[]): { allowed: string[]; unmapped: string[] } {
  const allowed: string[] = []
  const unmapped: string[] = []
  for (const tool of tools) {
    const mapped = CLAUDE_TOOL_NAMES[tool]
    if (mapped === undefined) unmapped.push(tool)
    else if (!allowed.includes(mapped)) allowed.push(mapped)
  }
  return { allowed, unmapped }
}

/**
 * Read both definition trees. A project file overrides a user file of the same `name`.
 * @param _ctx - owning runtime; model lookup is deferred until delegation.
 * @param sources - home and workspace roots; omitted roots fall back to the process home and cwd.
 * @returns one preset per distinct name, project copy winning.
 */
export async function claudeAgentPresets(_ctx: Context, sources: ClaudeAgentSources = {}): Promise<ClaudeAgentPreset[]> {
  const home = sources.home ?? homedir()
  const workspace = sources.workspace ?? process.cwd()
  const byName = new Map<string, ClaudeAgentFile>()
  for (const file of await readAgentDir(join(home, '.claude', 'agents'))) byName.set(file.name, file)
  for (const file of await readAgentDir(join(workspace, '.claude', 'agents'))) byName.set(file.name, file)
  return [...byName.values()].map((file): ClaudeAgentPreset => {
    const { allowed, unmapped } = mapTools(file.tools)
    return {
      id: file.name,
      unmappedTools: unmapped,
      definition: {
        id: file.name,
        ...file.description === '' ? {} : { description: file.description },
        ...file.model === '' ? {} : { model: file.model, reasoningEffort: file.effort },
        plugins: [{ name: INSTRUCTION_PLUGIN, config: { text: file.body, allowedTools: allowed } }],
      },
    }
  })
}
