/** PostgreSQL tables shared by KV units and the local ledger mirror. */
import type { Client } from 'pg'

/** Create the backend tables without changing existing user data. */
export async function initializeSchema(client: Client): Promise<void> {
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('panedesk-storage-schema'))")
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS panedesk;
      CREATE TABLE IF NOT EXISTS panedesk.storage_units (
        name TEXT PRIMARY KEY, version INTEGER NOT NULL, global_value TEXT
      );
      CREATE TABLE IF NOT EXISTS panedesk.storage_records (
        unit TEXT NOT NULL REFERENCES panedesk.storage_units(name),
        table_name TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY (unit, table_name, key)
      );
      CREATE TABLE IF NOT EXISTS panedesk.ledger (
        id TEXT PRIMARY KEY, value TEXT NOT NULL
      );
    `)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}
