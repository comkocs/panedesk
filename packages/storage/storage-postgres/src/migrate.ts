/** Read-only import of both JSON layouts; existing PostgreSQL keys are retained. */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { UNIT_NAME_RE, type KvUnitDescriptor } from '@panedesk/dsh-storage'
import type { Pool } from 'pg'

const wholeUnit = z.object({
  unit: z.object({ name: z.string().regex(UNIT_NAME_RE), version: z.number().int().nonnegative() }),
  global: z.unknown().optional(), tables: z.record(z.string().regex(UNIT_NAME_RE), z.record(z.string(), z.unknown())),
})
const record = z.object({ version: z.number().int().nonnegative(), record: z.unknown() })

/** Copy all discovered local units in one transaction, without deleting or rewriting local files. */
export async function migrateLocal(pool: Pool, root: string, descriptors: ReadonlyMap<string, KvUnitDescriptor>): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const units = new Map<string, { version: number; global: unknown; tables: Record<string, Record<string, unknown>> }>()
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const document = wholeUnit.parse(JSON.parse(await readFile(join(root, entry.name), 'utf8')))
    units.set(document.unit.name, { version: document.unit.version, global: document.global ?? null, tables: document.tables })
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !UNIT_NAME_RE.test(entry.name)) continue
    const descriptor = descriptors.get(entry.name)
    let version: number | undefined = descriptor?.version
    const tables: Record<string, Record<string, unknown>> = Object.create(null)
    let global: unknown = null
    let documents = 0
    const decode = async (path: string): Promise<unknown> => {
      const document = record.parse(JSON.parse(await readFile(path, 'utf8')))
      version ??= document.version
      if (document.version !== version && !descriptor?.compatibleVersions?.includes(document.version)) throw new Error(`Incompatible local version in unit '${entry.name}'`)
      documents++
      return document.record
    }
    for (const child of await readdir(join(root, entry.name), { withFileTypes: true })) {
      if (child.isFile() && child.name === 'global.json') global = await decode(join(root, entry.name, child.name))
      if (!child.isDirectory() || !UNIT_NAME_RE.test(child.name)) continue
      const records: Record<string, unknown> = Object.create(null)
      for (const file of await readdir(join(root, entry.name, child.name), { withFileTypes: true })) {
        if (file.isFile() && file.name.endsWith('.json')) records[file.name.slice(0, -5)] = await decode(join(root, entry.name, child.name, file.name))
      }
      tables[child.name] = records
    }
    if (documents && version !== undefined) units.set(entry.name, { version, global, tables })
  }
  const client = await pool.connect()
  let count = 0
  try {
    await client.query('BEGIN')
    for (const [name, unit] of units) {
      await client.query('INSERT INTO panedesk_storage_units (name, version) VALUES ($1, $2) ON CONFLICT DO NOTHING', [name, unit.version])
      const current = await client.query<{ version: number }>('SELECT version FROM panedesk_storage_units WHERE name = $1 FOR UPDATE', [name])
      if (current.rows[0]?.version !== unit.version) throw new Error(`Incompatible PostgreSQL version for unit '${name}'`)
      if (unit.global !== null) {
        const written = await client.query('UPDATE panedesk_storage_units SET global_value = $2 WHERE name = $1 AND global_value IS NULL', [name, JSON.stringify(unit.global)])
        count += written.rowCount ?? 0
      }
      for (const [table, records] of Object.entries(unit.tables)) {
        for (const [key, value] of Object.entries(records)) {
          const written = await client.query('INSERT INTO panedesk_storage_records (unit, table_name, key, value) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [name, table, key, JSON.stringify(value)])
          count += written.rowCount ?? 0
        }
      }
    }
    await client.query('COMMIT')
    return count
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}
