/** Strict offline-ledger argument parsing; unknown flags never become inferred filters. */
import type { LedgerQueryOptions, LedgerExportFormat, LedgerGroupBy } from './types.ts'
import { parseMessagesArgs } from './messages-cli.ts'
import type { MessagesCommand } from './messages-cli.ts'
import { parseEngineArgs, type EngineCommand } from './engine-cli.ts'

/** Parsed command with explicit file operands and shared query filters. */
export interface LedgerCommand {
  command: 'today' | 'query' | 'export' | 'merge' | 'live' | 'cache' | 'verify' | 'messages' | 'engine'
  engine?: EngineCommand
  messages?: MessagesCommand
  query: LedgerQueryOptions
  format?: LedgerExportFormat
  outputPath?: string
  inputs: readonly string[]
}
/** Parse the inner arguments supplied by boot/cmdline.
 * @param args - arguments after launcher profile selection.
 * @returns validated command; missing operands and unknown options throw.
 */
export function parseLedgerArgs(args: readonly string[]): LedgerCommand {
  if (args[0] === 'engine') return { command: 'engine', engine: parseEngineArgs(args), query: {}, inputs: [] }
  if (args[0] === 'messages') return { command: 'messages', messages: parseMessagesArgs(args), query: {}, inputs: [] }
  const command = args[0] ?? 'today'
  if (!['today', 'query', 'export', 'merge', 'live', 'cache', 'verify'].includes(command)) throw new Error('Unknown ledger command')
  const result: LedgerCommand = { command: command as LedgerCommand['command'], query: {}, inputs: [] }
  const inputs: string[] = [], seen = new Set<string>()
  const common = ['--from', '--to', '--seat', '--window', '--model', '--task', '--session', '--node', '--purpose', '--include-children']
  const allowed: Record<LedgerCommand['command'], readonly string[]> = {
    today: ['--timezone'], query: [...common, '--group-by'], export: [...common, '--format', '--output'],
    merge: ['--input', '--output'], live: ['--session', '--node', '--include-children'],
    cache: ['--session', '--include-children'], verify: ['--input'], messages: [], engine: [],
  }
  for (let i = 1; i < args.length; i++) {
    const flag = args[i] ?? ''
    if (!allowed[result.command].includes(flag)) throw new Error('Unknown or inapplicable ledger option')
    if (seen.has(flag) && flag !== '--input') throw new Error('Duplicate ledger option')
    seen.add(flag)
    if (flag === '--include-children') { result.query.includeChildren = true; continue }
    const value = args[++i]
    if (!value || value.startsWith('--')) throw new Error('Missing ledger option value')
    switch (flag) {
      case '--from': case '--to': {
        if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new Error('Ledger times require an explicit timezone')
        const time = Date.parse(value)
        if (!Number.isFinite(time)) throw new Error('Invalid ledger time')
        result.query[flag === '--from' ? 'from' : 'to'] = time; break
      }
      case '--seat': result.query.seat = value; break
      case '--window': result.query.window = value; break
      case '--model': result.query.model = value; break
      case '--task': result.query.taskId = value; break
      case '--session': result.query.sessionId = value as NonNullable<LedgerQueryOptions['sessionId']>; break
      case '--node': result.query.nodeId = value as NonNullable<LedgerQueryOptions['nodeId']>; break
      case '--purpose':
        if (value !== 'conversation' && value !== 'compaction' && value !== 'session-title' && value !== 'keepalive') throw new Error('Invalid ledger purpose')
        result.query.purpose = value; break
      case '--timezone': if (value !== 'Asia/Shanghai') throw new Error('Today uses Asia/Shanghai'); break
      case '--group-by': {
        const keys = value.split(',').map(key => key === 'task' ? 'taskId' : key)
        if (keys.some(key => !['seat', 'window', 'model', 'modelFamily', 'taskId', 'sessionId', 'nodeId', 'purpose', 'accountLabel'].includes(key)) || new Set(keys).size !== keys.length) throw new Error('Invalid ledger grouping')
        result.query.groupBy = keys as LedgerGroupBy[]; break
      }
      case '--format':
        if (value !== 'jsonl' && value !== 'csv') throw new Error('Invalid ledger export format')
        result.format = value; break
      case '--output': result.outputPath = value; break
      case '--input': inputs.push(value); break
    }
  }
  result.inputs = inputs
  if (result.query.from !== undefined && result.query.to !== undefined && result.query.from >= result.query.to) throw new Error('Invalid ledger time range')
  if (result.command === 'export' && (!result.format || !result.outputPath)) throw new Error('Export requires format and output')
  if (result.command === 'merge' && (!inputs.length || !result.outputPath)) throw new Error('Merge requires input and output')
  if (result.command === 'verify' && inputs.length !== 1) throw new Error('Verify requires exactly one input')
  if (result.command === 'cache' && !result.query.sessionId) throw new Error('Cache requires a session')
  return result
}
