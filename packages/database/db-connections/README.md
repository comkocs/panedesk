# PostgreSQL connections

Host-owned connection management for user databases. This package does not move Panedesk's own storage into PostgreSQL; a storage adapter can consume the Host interface below.

## Usage

Open **Settings → Panedesk → Database connections**, add a uniquely named connection, and paste a `postgres://user:password@host:port/database` URL or fill the fields. PostgreSQL also needs a username and database name, not just a host, port and password. The defaults are port `5432`, user `postgres`, database `postgres`, and SSL/SSH/model access off. The local host is relative to the Panedesk Host, not the browser. No MCP server is required.

Enable SSL to require a trusted server certificate. If the database port is private, enable **Connect through SSH**, enter the SSH server, port (default `22`) and user, and select a private-key path on the Host. The passphrase is optional for unencrypted keys. The database host and port are then resolved from the SSH server. The picker lists Host paths without uploading or copying the key. Test an unsaved form, then save it. Blank secrets on edit preserve previous values; explicit Clear controls remove them.

## Configuration and credentials

Non-secret metadata is atomically stored in `$PANEDESK_HOME/database-connections.json` (default home `~/.panedesk`). The `filename` plugin option overrides this path. The settings page displays its absolute path and offers Open. Names are unique, ids remain stable on rename, and model access defaults to false. A pasted URL is split in the browser and is never stored as a URL. The catalog parser rejects unknown fields, including accidental plaintext password fields.

Passwords and private-key passphrases use `ctx.credentials` records keyed `db-connections/db-<uuid>`: `kind: api-key`, password in `key`, passphrase in `env.SSH_PASSPHRASE`. The default credentials provider keeps these in `$PANEDESK_HOME/private/.credentials.yaml` with its existing private-file protections. This is the same store used for provider credentials, not a new encrypted vault. Reads exposed to the browser never return secrets. Settings RPC methods require an authenticated owner.

## Host API

`ctx.databaseConnections.listConnections(): Promise<DatabaseConnection[]>` lists metadata. `getConfig(id: string): Promise<DatabaseConnection>` resolves one id. `open(id: string, signal?: AbortSignal): Promise<OpenDatabaseConnection>` resolves credentials and returns `{ client: pg.Client, close(): Promise<void> }`; callers must close the handle in `finally`. `close(id: string): Promise<void>` closes all live handles for that id. Settings expose `inspect`, `save`, `remove`, `test`, and `browseKeys` through generated Remote methods. `test` probes with `SELECT 1` and always releases its handle.

SSH starts only when opening or testing a connection, binds an ephemeral loopback-only port, and forwards to the configured database host. Handle closure, cancellation, transport loss, deletion, and plugin disposal release sockets and the forward. No database or SSH session starts just by loading the package.

## Model Experience

This package itself adds no prompt or tool. The separate SQL consumer exposes only connections explicitly enabled for model access. Metadata inspection has no token or KV-cache cost; SQL tool changes and results do.

## Known Limitations and Deferred Work

The ordinary SSH helper package requires a version-matched remote runtime, so this package uses the portable `ssh2` implementation instead. SSH key authentication is supported, but SSH password login, jump-host chains, host-key pinning/known-hosts management, and custom SSL certificate forms are not provided here. Use a trusted SSH network or verify the SSH endpoint outside this feature. SSL requires a certificate trusted by Node. URL query parameters other than supported `sslmode` values are rejected instead of silently ignored; SSL modes other than disable all enable certificate verification. Editing the JSON file externally requires a service reload to refresh the model's connection-name schema; execution always rechecks the catalog. Multiple SQL statements in one tool call share a connection; separate calls do not share transactions.
