# PostgreSQL storage

Stores Panedesk storage-domain units in a user-owned PostgreSQL database using the pure-JavaScript `pg` driver. The `postgres` registration selects PostgreSQL at startup when configured and reachable, otherwise the existing `json` backend. Local storage is the default; conversation bodies and the local ledger remain on disk.

## Configuration

Open **Settings → Panedesk → Data storage**. Enter a host, port (5432 by default), database, username, password and SSL preference. Save, optionally copy existing local data, and restart. Test connection checks the unsaved form and table creation permissions without selecting a new backend. The database must already exist; the supplied role must be allowed to create and use tables. SSL enables certificate verification.

Non-secret connection fields are stored in `$PANEDESK_HOME/storage.json` (default `~/.panedesk/storage.json`). The password uses `credentials.set` with the `PANEDESK_POSTGRES_PASSWORD` reference, like model API keys, and is stored by the configured credentials provider (normally `$PANEDESK_HOME/private/.credentials.yaml`). No password is returned by the settings API. The configuration and local data root can be overridden by the plugin's `configPath` and `localRoot` fields.

The page displays the resolved absolute configuration path. Save once before opening a configuration file that does not yet exist. A failed startup connection exposes a single-line error and leaves all units on local storage for that process. An established PostgreSQL connection failing later reports the operation failure rather than silently sending writes to a different dataset. Changes to backend or password require a restart.

## Storage and migration

The KV facet supports any declared storage-domain unit: versioned open, full snapshot, record upsert/delete, global singleton writes and drained close. Tables `panedesk_storage_units`, `panedesk_storage_records` and `panedesk_ledger` are created with `CREATE TABLE IF NOT EXISTS`. JSON values are opaque text; names, record keys and values are SQL parameters. Unit version mismatches fail instead of rewriting data.

**Copy existing local data to PostgreSQL** reads both single-file and per-record JSON layouts, writes one PostgreSQL transaction and reports newly inserted record/global rows. Existing remote keys and globals win, allowing repeat imports without overwriting shared data. Local files are not deleted or rewritten. Invalid local documents or incompatible versions abort the import. Save the intended connection first, stop other local writers for a stable source snapshot, then restart after the copy. The button does not change the selected backend.

Committed body-free call/run ledger facts are also queued to PostgreSQL while PostgreSQL is active. Local journal durability does not wait for this mirror. Statistics reconcile retained local facts before reading the PostgreSQL ledger, recovering interrupted secondary writes; read failures remain visible. Other ledger queries and message journals remain unchanged.

## Model Experience

No prompts, tools, model requests, token usage or KV-cache behavior are changed. This package changes where non-conversation application data and a secondary accounting copy are stored.

## Known Limitations and Deferred Work

Storage-domain consumers cache their opened data in process memory. Multiple machines may use the same database, but this backend does not add live cache invalidation or conflict-free editing of the same logical record; restart to load other machines' changes. PostgreSQL backups, database creation, credentials rotation and network access are user-administered. Migration is an explicit copy, not bidirectional synchronization. Statistics reconciliation currently reads the retained local ledger and the full shared ledger. No real database validation is performed as part of this change.
