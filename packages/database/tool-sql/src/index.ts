/** Model-facing PostgreSQL operations, visible only for owner-enabled connections. */
import type { Context } from '@panedesk/cordis'
import schema from '@panedesk/schemastery'
import { defineTool } from '@panedesk/dsh-tools'
import type {} from '@panedesk/dsh-db-connections'
import pg from 'pg'

export const name = 'tool-sql'
export const inject = ['tools', 'databaseConnections']

/** Output retention only; SQL authority is entirely the database account's permissions. */
export interface Config { maxRows: number; maxCharacters: number }
export const Config: schema<Config> = schema.object({
  maxRows: schema.number().step(1).min(1).default(200),
  maxCharacters: schema.number().step(1).min(1024).default(32000),
})

const tables = `SELECT table_schema || '.' || table_name AS "table"
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name`
const structure = `SELECT a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS data_type,
NOT a.attnotnull AS nullable, EXISTS (
  SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)
) AS primary_key
FROM pg_attribute a WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`

/** Register one tool with a connection-name enum; refresh only on explicit settings changes. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  let dispose: (() => void) | undefined
  let stopped = false
  let refresh = Promise.resolve()
  const update = async () => {
    const connections = (await ctx.databaseConnections.listConnections()).filter(row => row.modelEnabled)
    if (stopped) return
    dispose?.()
    dispose = undefined
    if (!connections.length) return
    dispose = ctx.tools.register(defineTool({
      name: 'sql',
      description: 'Use a PostgreSQL connection enabled by the user. List schema.table names, describe columns/types/nullability/primary keys, or execute SQL. SQL can read or change data according to the database account permissions. Results report total rows and any truncation.',
      parameters: {
        connection: { type: 'string', enum: connections.map(row => row.name), required: true, description: 'Enabled connection name.' },
        operation: { type: 'string', enum: ['list_tables', 'describe_table', 'execute_sql'], required: true },
        table: { type: 'string', description: 'For describe_table: schema.table, with SQL identifier quoting if needed.' },
        sql: { type: 'string', description: 'For execute_sql: SQL text. No extra statement restrictions are imposed.' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        const connection = (await ctx.databaseConnections.listConnections()).find(row => row.name === args.connection && row.modelEnabled)
        if (!connection) throw new Error('This database connection is not enabled for model access')
        let text: string, values: string[] = []
        switch (args.operation) {
          case 'list_tables': text = tables; break
          case 'describe_table':
            if (!args.table) throw new Error('table is required for describe_table')
            text = structure; values = [args.table]; break
          case 'execute_sql':
            if (!args.sql) throw new Error('sql is required for execute_sql')
            text = args.sql; break
          default: throw new Error('Unknown SQL operation')
        }
        const handle = await ctx.databaseConnections.open(connection.id, exec.signal)
        try {
          return await new Promise<string>((resolve, reject) => {
            const rows: string[] = []
            let totalRows = 0, characters = 0, truncated = false
            // Row events avoid retaining the unbounded driver result. The query still runs to completion.
            const query = new pg.Query({ text, values })
            query.on('row', (row: Record<string, unknown>) => {
              totalRows++
              const line = JSON.stringify(row)
              if (truncated || rows.length >= config.maxRows || characters + line.length + 1 > config.maxCharacters - 512) {
                truncated = true
              } else { rows.push(line); characters += line.length + 1 }
            })
            query.once('error', reject)
            query.once('end', (result: pg.QueryResult | pg.QueryResult[]) => {
              const results = Array.isArray(result) ? result : [result]
              const affectedRows = results.reduce((sum, item) => sum + (item.rowCount ?? 0), 0)
              resolve(`${rows.join('\n')}\nTotal rows: ${totalRows}; returned rows: ${rows.length}; affected/reported rows: ${affectedRows}; truncated: ${truncated}.`)
            })
            handle.client.query(query)
          })
        } finally { await handle.close() }
      },
    }))
  }
  ctx.effect(() => () => { stopped = true; dispose?.() })
  ctx.on('database-connections/changed', () => {
    refresh = refresh.then(update).catch((error: unknown) => {
      dispose?.(); dispose = undefined
      ctx.logger.error('Could not refresh database tools: %s', error instanceof Error ? error.message : String(error))
    })
  })
  await update()
}
