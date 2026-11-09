# Data storage settings

Adds **Settings → Panedesk → Data storage** with Local (default) and saved database connection choices, a `SELECT 1` connection test and optional local-data copying. Connections are added on the Database connections page. The page shows the absolute configuration path with open/reveal actions, the current backend, connection errors and restart requirements. [The backend README](../../storage/storage-postgres/README.md) owns persistence, migration and credential behavior.

The shared Panedesk header explains the local default and database prerequisites. Only some application data moves; local session journals remain on this computer, and another computer reads database-backed data after restart rather than receiving live synchronization.

Page actions use shared outlined buttons; Save uses the primary style.

## Model Experience

No model-facing tools, prompts, token usage or KV-cache changes. The page only calls owner-authenticated settings methods.

## Known Limitations and Deferred Work

Changes take effect after restart. The configuration file must be saved before opening it for the first time. The page handles only connection ids and names, never credentials. Opening a local path requires a host with the existing desktop path-opening capability.
