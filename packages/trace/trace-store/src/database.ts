/** Versioned project-local SQLite layout; callers own the single Host write queue. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { TraceEvent, TraceReference, TraceSource, ItemId, ReferenceId } from './types.ts'
import { randomUUID } from 'node:crypto'

/** Initial physical schema; unrelated to Session log format versions. */
const SCHEMA_VERSION = 1

/** Open one explicitly selected project, never enumerate sibling projects.
 * @param directory Project directory under the Harness home.
 * @returns WAL database with the current schema.
 */
export function openProjectDatabase(directory: string): DatabaseSync {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(directory, 'trace.sqlite'))
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON')
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (version.user_version !== 0 && version.user_version !== SCHEMA_VERSION) throw new Error('Unsupported trace database version')
    if (version.user_version === 0) db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE schema_meta (version INTEGER NOT NULL) STRICT;
      CREATE TABLE items (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open','closed','void')), source TEXT NOT NULL
      ) STRICT;
      CREATE TABLE events (
        id INTEGER PRIMARY KEY, item_id INTEGER REFERENCES items(id), type TEXT NOT NULL,
        session_id TEXT, seq_start INTEGER, seq_end INTEGER, actor TEXT NOT NULL,
        operation_session TEXT, model TEXT, time INTEGER NOT NULL, payload TEXT NOT NULL,
        dedup_key TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE INDEX events_item_cursor ON events(item_id, id);
      CREATE TABLE comments (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id), item_id INTEGER NOT NULL REFERENCES items(id), body TEXT NOT NULL) STRICT;
      CREATE TABLE refs (
        id TEXT PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id),
        kind TEXT NOT NULL CHECK(kind IN ('session-slice','attachment','change')),
        session_id TEXT, seq_start INTEGER, seq_end INTEGER, path TEXT,
        before_hash TEXT, after_hash TEXT, summary TEXT NOT NULL, diff_file TEXT
      ) STRICT;
      CREATE TABLE decisions (id TEXT PRIMARY KEY, active_revision INTEGER) STRICT;
      CREATE TABLE decision_revs (
        decision_id TEXT NOT NULL REFERENCES decisions(id), revision INTEGER NOT NULL,
        item_id INTEGER REFERENCES items(id), title TEXT NOT NULL, body TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','proposed','rejected','reverted')),
        source TEXT NOT NULL, PRIMARY KEY(decision_id, revision)
      ) STRICT;
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE session_links (session_id TEXT PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id)) STRICT;
      INSERT INTO schema_meta VALUES (${SCHEMA_VERSION});
      PRAGMA user_version = ${SCHEMA_VERSION};
      COMMIT;
    `)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/** SQL columns projected into the public reference field names. */
export const referenceColumns = 'id, event_id AS eventId, kind, session_id AS sessionId, seq_start AS seqStart, seq_end AS seqEnd, path, before_hash AS beforeHash, after_hash AS afterHash, summary, diff_file AS diffFile'

/** Append a fact inside the caller's transaction; duplicates retain the original fact.
 * @param db Selected project database.
 * @param input Event fields without the database-generated number.
 * @returns New event number, or null when already captured.
 */
export function appendEvent(db: DatabaseSync, input: Omit<TraceEvent, 'id'>): number | null {
  const result = db.prepare(`INSERT INTO events(item_id,type,session_id,seq_start,seq_end,actor,operation_session,model,time,payload,dedup_key)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dedup_key) DO NOTHING`).run(
    input.itemId, input.type, input.sessionId, input.seqStart, input.seqEnd,
    input.source.actor, input.source.sessionId, input.source.model, input.source.time, input.payload, input.dedupKey,
  )
  return result.changes === 0 ? null : Number(result.lastInsertRowid)
}

/** Insert one reference alongside its event.
 * @param db Selected project database.
 * @param reference Reference fields without the generated identity.
 * @returns Persisted reference identity.
 */
export function appendReference(db: DatabaseSync, reference: Omit<TraceReference, 'id'>): ReferenceId {
  const id = randomUUID() as ReferenceId
  db.prepare('INSERT INTO refs VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, reference.eventId, reference.kind,
    reference.sessionId, reference.seqStart, reference.seqEnd, reference.path, reference.beforeHash,
    reference.afterHash, reference.summary, reference.diffFile)
  return id
}

/** Append a user/service mutation fact in the same transaction as its state.
 * @param db Selected project database.
 * @param type Mutation discriminator.
 * @param itemId Item selection; null is unassigned.
 * @param source Captured invocation attribution.
 * @param payload JSON metadata.
 * @returns Event number.
 */
export function mutationEvent(db: DatabaseSync, type: string, itemId: ItemId | null, source: TraceSource, payload: string): number {
  return appendEvent(db, { type, itemId, source, sessionId: source.sessionId, seqStart: null, seqEnd: null, payload, dedupKey: randomUUID() })!
}
