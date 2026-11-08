# Database connection settings

Adds **Settings → Panedesk → Database connections** using the shared settings section slot, typed English/Chinese copy and the generated `databaseConnections` Remote contribution.

## Usage

Add, edit or delete named PostgreSQL connections. Paste a PostgreSQL URL to automatically fill host, port, username, password and database, or fill the fields directly. Defaults are shown on the page. Passwords remain masked and successful URL parsing clears the pasted URL. Blank secret fields preserve saved values; explicit Clear controls remove them. Testing uses the unsaved form and reports a plain-language result plus the original one-line error.

SSL verifies the database certificate. SSH uses a Host-side private-key path, optionally chosen with the directory/file browser; the browser receives names and paths, never key contents. The database host is reached from the SSH server when tunneling is enabled. Configuration inspection shows the absolute JSON file path and Open uses the existing Host path action. Each connection has a model-access toggle, off by default. The page explains that SQL permissions are those of the database account, including writes.

## Model Experience

The page itself adds no model context. Enabling model access updates the SQL tool's connection-name choices; passwords, SSH passphrases and private-key contents never become tool arguments.

## Known Limitations and Deferred Work

The page configures user database access, not Panedesk's own storage backend. The Host's Open action needs desktop integration; a remote/headless Host may refuse it while leaving the displayed path available. The private-key picker browses the Host filesystem, not the browser's filesystem. Client drafts are lost on page unload and no secret read-back is offered.
