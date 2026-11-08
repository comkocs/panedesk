# Data storage settings

Adds **Settings → Panedesk → Data storage** with local/PostgreSQL selection, host, port, database, username, password, SSL, connection testing and optional local-data copying. The page shows the absolute configuration path with open/reveal actions, the current backend, connection errors and restart requirements. [The backend README](../../storage/storage-postgres/README.md) owns persistence, migration and credential behavior.

## Model Experience

No model-facing tools, prompts, token usage or KV-cache changes. The page only calls owner-authenticated settings methods.

## Known Limitations and Deferred Work

Changes take effect after restart. The configuration file must be saved before opening it for the first time. Browser password drafts stay in component memory and are cleared after saving; saved credentials are never read back. Opening a local path requires a host with the existing desktop path-opening capability.
