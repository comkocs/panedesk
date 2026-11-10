/** Offline project trace reads; no profile, writer, or database initialization is loaded. */
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SQLOutputValue } from 'node:sqlite'
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander'
import { resolveDshHome } from '@panedesk/dsh-home-paths'

interface TraceOptions { workspace?: string }
interface TimelineOptions { cursor: number; limit: number }
type Row = Record<string, SQLOutputValue>

function positiveInteger(value: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw new InvalidArgumentError('expected a positive integer')
  return number
}

function decodeSource(row: Row): object {
  return { ...row, source: JSON.parse(row.source as string) as object }
}

const eventColumns = `id,item_id AS itemId,type,session_id AS sessionId,seq_start AS seqStart,seq_end AS seqEnd,
  json_object('actor',actor,'sessionId',operation_session,'model',model,'time',time) AS source,payload,dedup_key AS dedupKey`
const refColumns = `id,event_id AS eventId,kind,session_id AS sessionId,seq_start AS seqStart,seq_end AS seqEnd,
  path,before_hash AS beforeHash,after_hash AS afterHash,summary,diff_file AS diffFile`
const decisionColumns = 'r.decision_id AS id,r.revision,r.item_id AS itemId,r.title,r.body,r.status,r.source'

async function openTrace(workspace: string): Promise<DatabaseSync> {
  const home = resolveDshHome()
  const path = await realpath(resolve(workspace))
  const registry = JSON.parse(await readFile(join(home, 'storages', 'project-traces.json'), 'utf8')) as {
    tables: { workspaces: Record<string, { projectId: string | null; enabled: boolean }> }
  }
  const match = Object.entries(registry.tables.workspaces)
    .filter(([root]) => {
      const suffix = relative(root, path)
      return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
    })
    .sort(([left], [right]) => right.length - left.length)[0]
  if (match === undefined || !match[1].enabled || match[1].projectId === null) {
    throw new Error('This project has not enabled trace recording; ask the user to enable it in workspace settings.')
  }
  return new DatabaseSync(join(home, 'projects', match[1].projectId, 'trace.sqlite'), { readOnly: true })
}

function timeline(db: DatabaseSync, itemId: number, options: TimelineOptions): object {
  const rows = db.prepare(`SELECT ${eventColumns} FROM events WHERE item_id=? AND id>? ORDER BY id LIMIT ?`)
    .all(itemId, options.cursor, options.limit + 1)
  const selected = rows.slice(0, options.limit)
  return {
    events: selected.map(decodeSource),
    refs: selected.flatMap(event => db.prepare(`SELECT ${refColumns} FROM refs WHERE event_id=?`).all(event.id!)),
    nextCursor: rows.length > options.limit ? selected.at(-1)!.id : null,
  }
}

/** Run a read-only trace command and print its result to stdout.
 * @param argv Arguments following `trace`; --workspace defaults to the current directory.
 * @returns Zero on success/help, otherwise a nonzero command exit code.
 */
export async function runTrace(argv: readonly string[]): Promise<number> {
  const program = new Command('panedesk trace')
    .description('Read project activity from the local global workspace mapping and SQLite database; never write either.')
    .option('--workspace <path>', 'workspace path or a directory inside it (default: current directory)')
    .exitOverride()
  const read = async (command: Command, query: (db: DatabaseSync) => unknown): Promise<void> => {
    const options = command.optsWithGlobals<TraceOptions>()
    const db = await openTrace(options.workspace ?? process.cwd())
    try { process.stdout.write(`${JSON.stringify(query(db), null, 2)}\n`) }
    finally { db.close() }
  }
  program.command('items').description('List all items in creation order')
    .action(async (_options, command: Command) => read(command, db => db.prepare('SELECT * FROM items ORDER BY id').all().map(decodeSource)))
  program.command('timeline <item>').description('Read one item timeline with an exclusive event cursor')
    .option('--cursor <event>', 'last event number from the previous page', positiveInteger, 0)
    .option('--limit <count>', 'maximum events per page', positiveInteger, 100)
    .action(async (item: string, options: TimelineOptions, command: Command) => {
      const itemId = positiveInteger(item)
      await read(command, db => timeline(db, itemId, options))
    })
  program.command('decisions').description('List currently active decision revisions')
    .action(async (_options, command: Command) => read(command, db => db.prepare(`SELECT ${decisionColumns}
      FROM decisions d JOIN decision_revs r ON r.decision_id=d.id AND r.revision=d.active_revision ORDER BY r.decision_id`)
      .all().map(decodeSource)))
  program.command('export <item>').description('Export an item, complete timeline, references, comments, and decision history to stdout')
    .addOption(new Option('--format <format>', 'export format; Markdown can be checked into git').choices(['json', 'md']).default('json'))
    .action(async (item: string, options: { format: string }, command: Command) => {
      const itemId = positiveInteger(item)
      const db = await openTrace(command.optsWithGlobals<TraceOptions>().workspace ?? process.cwd())
      try {
        db.exec('BEGIN')
        const row = db.prepare('SELECT * FROM items WHERE id=?').get(itemId)
        if (row === undefined) throw new Error(`Item ${itemId} does not exist`)
        const data = {
          item: decodeSource(row),
          events: db.prepare(`SELECT ${eventColumns} FROM events WHERE item_id=? ORDER BY id`).all(itemId).map(decodeSource),
          refs: db.prepare(`SELECT ${refColumns} FROM refs WHERE event_id IN (SELECT id FROM events WHERE item_id=?) ORDER BY event_id,id`).all(itemId),
          comments: db.prepare('SELECT id,event_id AS eventId,item_id AS itemId,body FROM comments WHERE item_id=? ORDER BY id').all(itemId),
          decisions: db.prepare(`SELECT ${decisionColumns} FROM decision_revs r WHERE r.item_id=? ORDER BY r.decision_id,r.revision`).all(itemId).map(decodeSource),
        }
        db.exec('COMMIT')
        const json = JSON.stringify(data, null, 2)
        process.stdout.write(options.format === 'md' ? `# Trace item ${itemId}\n\n${json.split('\n').map(line => `    ${line}`).join('\n')}\n` : `${json}\n`)
      } finally { db.close() }
    })
  try {
    await program.parseAsync(argv, { from: 'user' })
    if (argv.length === 0) program.outputHelp()
    return 0
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode
    process.stderr.write(`panedesk trace: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
