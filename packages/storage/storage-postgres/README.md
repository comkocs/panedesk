# PostgreSQL storage

Stores Panedesk storage-domain units in a user-owned PostgreSQL database using the pure-JavaScript `pg` driver. The `postgres` registration selects PostgreSQL at startup when configured and reachable, otherwise the existing `json` backend. Local storage is the default; conversation bodies and the local ledger remain on disk.

## Configuration

Open **Settings → Panedesk → Data storage**. Select Local (default) or a saved connection by name. Add connections on the Database connections page; SSL, credentials and optional SSH tunnels are managed there. Save, optionally copy existing local data, and restart. Test connection only runs `SELECT 1`; it does not create tables or select a new backend. The database must already exist; the supplied role must be allowed to create the `panedesk` schema and use its tables when storage is enabled.

Only the backend selection and saved connection id are stored in `$PANEDESK_HOME/storage.json` (default `~/.panedesk/storage.json`). The database-connections service resolves configuration and opens the client, including any SSH tunnel. This backend does not read or store passwords. The configuration and local data root can be overridden by the plugin's `configPath` and `localRoot` fields.

The page displays the resolved absolute configuration path. Save once before opening a configuration file that does not yet exist. A failed startup connection exposes a single-line error and leaves all units on local storage for that process. An established PostgreSQL connection failing later reports the operation failure rather than silently sending writes to a different dataset. Changes to the selected backend or connection require a restart.

## Storage and migration

The KV facet supports any declared storage-domain unit: versioned open, full snapshot, record upsert/delete, global singleton writes and drained close. The `panedesk` schema is created with `CREATE SCHEMA IF NOT EXISTS`; tables `panedesk.storage_units`, `panedesk.storage_records` and `panedesk.ledger` are created there with `CREATE TABLE IF NOT EXISTS`. Existing tables outside that schema are neither read nor modified. JSON values are opaque text; names, record keys and values are SQL parameters. Unit version mismatches fail instead of rewriting data.

**Copy existing local data to PostgreSQL** reads both single-file and per-record JSON layouts, writes one PostgreSQL transaction and reports newly inserted record/global rows. Existing remote keys and globals win, allowing repeat imports without overwriting shared data. Local files are not deleted or rewritten. Invalid local documents or incompatible versions abort the import. Save the intended connection first, stop other local writers for a stable source snapshot, then restart after the copy. The button does not change the selected backend.

Committed body-free call/run ledger facts are also queued to PostgreSQL while PostgreSQL is active. Local journal durability does not wait for this mirror. Statistics reconcile retained local facts before reading the PostgreSQL ledger, recovering interrupted secondary writes; read failures remain visible. Other ledger queries and message journals remain unchanged.

## Model Experience

No prompts, tools, model requests, token usage or KV-cache behavior are changed. This package changes where non-conversation application data and a secondary accounting copy are stored.

## Known Limitations and Deferred Work

Storage-domain consumers cache their opened data in process memory. Multiple machines may use the same database, but this backend does not add live cache invalidation or conflict-free editing of the same logical record; restart to load other machines' changes. PostgreSQL backups, database creation, credentials rotation and network access are user-administered. Migration is an explicit copy, not bidirectional synchronization. Statistics reconciliation currently reads the retained local ledger and the full shared ledger. No real database validation is performed as part of this change.
