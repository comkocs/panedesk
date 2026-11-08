/** One PostgreSQL KV unit; SQL values are parameterized opaque JSON documents. */
import type { Client } from 'pg'
import { StorageError, type KvUnit, type KvUnitDescriptor } from '@panedesk/dsh-storage'

export class PostgresKvUnit implements KvUnit {
  private closing: Promise<void> | undefined
  private readonly pending = new Set<Promise<unknown>>()

  constructor(private readonly client: Client, private readonly descriptor: KvUnitDescriptor, private readonly onClose: () => void) {}

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new StorageError('closed', `unit '${this.descriptor.name}' is closed`))
    const pending = Promise.resolve().then(operation)
    this.pending.add(pending)
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending))
    return pending
  }

  loadAll(): ReturnType<KvUnit['loadAll']> {
    return this.run(async () => {
      const result = await this.client.query<{ table_name: string | null; key: string | null; value: string | null }>(`
        SELECT table_name, key, value FROM panedesk.storage_records WHERE unit = $1
        UNION ALL
        SELECT NULL, NULL, global_value FROM panedesk.storage_units WHERE name = $1
      `, [this.descriptor.name])
      const tables: Record<string, Record<string, unknown>> = Object.fromEntries(this.descriptor.tables.map(table => [table, Object.create(null)]))
      let global: unknown = null
      for (const row of result.rows) {
        if (row.value === null) continue
        let value: unknown
        try { value = JSON.parse(row.value) }
        catch (error) { throw new StorageError('malformed-medium', `Invalid JSON in unit '${this.descriptor.name}'`, { cause: error }) }
        if (row.table_name === null) { if (this.descriptor.hasGlobal) global = value }
        else if (row.key !== null && tables[row.table_name]) tables[row.table_name]![row.key] = value
      }
      return { tables, global }
    })
  }

  private checkTable(table: string): void {
    if (!this.descriptor.tables.includes(table)) throw new Error(`Undeclared table '${table}' in unit '${this.descriptor.name}'`)
  }

  putRecord(table: string, key: string, value: unknown): Promise<void> {
    return this.run(async () => {
      this.checkTable(table)
      await this.client.query(`INSERT INTO panedesk.storage_records (unit, table_name, key, value) VALUES ($1, $2, $3, $4)
        ON CONFLICT (unit, table_name, key) DO UPDATE SET value = EXCLUDED.value`, [this.descriptor.name, table, key, JSON.stringify(value)])
    })
  }

  deleteRecord(table: string, key: string): Promise<void> {
    return this.run(async () => {
      this.checkTable(table)
      await this.client.query('DELETE FROM panedesk.storage_records WHERE unit = $1 AND table_name = $2 AND key = $3', [this.descriptor.name, table, key])
    })
  }

  setGlobal(value: unknown): Promise<void> {
    return this.run(async () => {
      if (!this.descriptor.hasGlobal) throw new Error(`Unit '${this.descriptor.name}' has no global slot`)
      await this.client.query('UPDATE panedesk.storage_units SET global_value = $2 WHERE name = $1', [this.descriptor.name, JSON.stringify(value)])
    })
  }

  close(): Promise<void> {
    this.closing ??= Promise.allSettled([...this.pending]).then(() => { this.onClose() })
    return this.closing
  }
}
