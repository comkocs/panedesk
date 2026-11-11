/** Ordered command and tool classification, independent of policy enforcement. */
import { resolve } from 'node:path'
import type { ActivityCategory } from './categories.ts'

/** A workspace override; the first matching nonempty literal wins. */
export interface ActivityRule {
  /** Nonempty literal substring to match in the command. */
  contains: string
  /** Primary activity category assigned to a matching command. */
  category: ActivityCategory
}

/** Task-local evidence supplied by the activity service for one session. */
export interface ActivitySession {
  cwd: string
  createdFiles: readonly string[]
  rules: readonly ActivityRule[]
}

/** One primary category plus an independent, non-additive script tag. */
export interface ActivityClassification {
  category: ActivityCategory
  selfWrittenScript: boolean
}

interface MatchInput {
  name: string
  args: Readonly<Record<string, unknown>>
  command: string
  testCommand: string
  words: readonly string[]
  selfWrittenScript: boolean
}

/** Split command words while retaining quoted paths and shell command separators. */
function words(command: string): string[] {
  return (command.match(/(?:[^\s'";&|]+|'[^']*'|"[^"]*")+|&&|\|\||[;&|]/g) ?? [])
    .map(word => word.replace(/(['"])(.*?)\1/g, '$2'))
}

function runsCreatedFile(tokens: readonly string[], session: ActivitySession): boolean {
  let cwd = session.cwd
  let start = 0
  for (let end = 0; end <= tokens.length; end++) {
    if (end < tokens.length && ![';', '&&', '||', '|', '&'].includes(tokens[end]!)) continue
    const segment = tokens.slice(start, end)
    start = end + 1
    if (segment[0] === 'cd' && segment[1]) { cwd = resolve(cwd, segment[1]); continue }
    let executable = 0
    while (/^[A-Za-z_][\w]*=/.test(segment[executable] ?? '') || ['env', 'command', 'exec'].includes(segment[executable] ?? '')) executable++
    const program = segment[executable]
    if (program === undefined) continue
    if (session.createdFiles.includes(resolve(cwd, program))) return true
    if (/^(?:.*[/\\])?(?:python[\d.]*|node|tsx|ts-node|bash|sh|zsh|ruby|perl|pwsh|powershell)(?:\.exe)?$/.test(program)) {
      for (const argument of segment.slice(executable + 1)) {
        if (['-c', '-e', '--eval', '-m', '-Command'].includes(argument)) break
        if (argument.startsWith('-')) continue
        if (session.createdFiles.includes(resolve(cwd, argument))) return true
        break
      }
    }
  }
  return false
}

const TEST_RUNNER = /(?:^|[\s;&|])(?:pytest|vitest|jest|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|(?:npm|pnpm|yarn)(?:\s+run)?\s+test)(?=\s|:|$)/

function focused(command: string): boolean {
  const match = TEST_RUNNER.exec(command)
  if (match === null) return false
  const suffix = command.slice(match.index + match[0].length).split(/&&|\|\||;/)[0] ?? ''
  const args = words(suffix)
  if (args.some(arg => /^(?:-k|-t|-m|--filter|--changed|--testNamePattern|--testPathPattern|--runTestsByPath|--grep|-run|-Dtest|-Dtest.single)(?:=|$)/.test(arg))) return true
  // Runner mode and output options do not select tests; their values are not paths.
  const values = new Set(['--reporter', '--reporters', '--coverage-directory', '--outputFile', '--maxWorkers', '-n', '-j', '--configuration', '-c', '--logger'])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (values.has(arg)) { i++; continue }
    if (arg.startsWith('-') || ['run', 'watch', ':coverage', ':unit', ':all'].includes(arg)) continue
    if (arg === './...' || arg === './.../' || arg === '...') continue
    return true
  }
  return false
}

/** Single ordered default rule table. Workspace literal rules take precedence for commands. */
export const ACTIVITY_RULES: readonly { category: ActivityCategory; matches: (input: MatchInput) => boolean }[] = [
  { category: 'write', matches: ({ name }) => /^(?:edit|write|apply_patch|notebook_edit)$/.test(name) },
  { category: 'read', matches: ({ name }) => /^(?:read|glob|grep|list|ls|search|web(?:_.*)?|fetch|browse)$/.test(name) },
  { category: 'wait', matches: ({ name, args }) => name === 'ask_user_question' || name === 'wait' || name === 'subagent_wait' || (name === 'job_output' && args['wait'] === true) },
  { category: 'mutation', matches: ({ command }) => /\b(?:mutmut|stryker|cargo-mutants|pitest)\b|\bcargo\s+mutants\b/.test(command) },
  { category: 'client', matches: ({ command }) => /\b(?:playwright|cypress|godot|electron|MetaTrader|terminal64\.exe)\b|\b(?:dev|start):(web|desktop)\b|\bdsh\s+(?:web|desktop)\b/i.test(command) },
  { category: 'ci', matches: ({ command }) => /\bgit\s+push\b|\bgh\s+(?:workflow\s+run|run\s+watch)\b/.test(command) },
  { category: 'test-focused', matches: ({ testCommand }) => TEST_RUNNER.test(testCommand) && focused(testCommand) },
  { category: 'test-full', matches: ({ testCommand }) => TEST_RUNNER.test(testCommand) },
  { category: 'build', matches: ({ command }) => /\b(?:tsc|build|make|msbuild)\b|\bgradle\s+assemble\b|\bmetaeditor(?:64)?(?:\.exe)?\b.*\/compile/i.test(command) },
  { category: 'script', matches: ({ selfWrittenScript }) => selfWrittenScript },
  { category: 'other', matches: () => true },
]

/** Classify a tool using task-owned creation evidence, never script filename conventions.
 * @param toolName Runtime tool name.
 * @param args Parsed tool arguments.
 * @param session Calling session's working directory, task-created paths and workspace rules.
 * @returns Primary category and independent self-written-script tag.
 */
export function classifyActivity(toolName: string, args: Readonly<Record<string, unknown>>, session: ActivitySession): ActivityClassification {
  const command = typeof args['command'] === 'string' ? args['command'] : ''
  const tokens = words(command)
  const directory = typeof args['workdir'] === 'string' ? resolve(session.cwd, args['workdir']) : session.cwd
  const selfWrittenScript = command !== '' && runsCreatedFile(tokens, { ...session, cwd: directory })
  const override = command === '' ? undefined : session.rules.find(rule => rule.contains !== '' && command.includes(rule.contains))
  const testCommand = command.replace(/('[^']*'|"[^"]*"|\|\|)|\|[\s\S]*$|\d*>>?\s*(?:&\d+|(?:[^\s;&|<>"']+|'[^']*'|"[^"]*")+)/g,
    (_match, quoted: string | undefined) => quoted ?? '')
  const input = { name: toolName.toLowerCase(), args, command, testCommand, words: tokens, selfWrittenScript }
  return { category: override?.category ?? ACTIVITY_RULES.find(rule => rule.matches(input))!.category, selfWrittenScript }
}
