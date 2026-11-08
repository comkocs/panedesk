/** PostgreSQL tables shared by KV units and the local ledger mirror. */
import type { Pool } from 'pg'

/** Create the backend tables without changing existing user data. */
export async function initializeSchema(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('panedesk-storage-schema'))")
    await client.query(`
      CREATE TABLE IF NOT EXISTS panedesk_storage_units (
        name TEXT PRIMARY KEY, version INTEGER NOT NULL, global_value TEXT
      );
      CREATE TABLE IF NOT EXISTS panedesk_storage_records (
        unit TEXT NOT NULL REFERENCES panedesk_storage_units(name),
        table_name TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY (unit, table_name, key)
      );
      CREATE TABLE IF NOT EXISTS panedesk_ledger (
        id TEXT PRIMARY KEY, value TEXT NOT NULL
      );
    `)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
