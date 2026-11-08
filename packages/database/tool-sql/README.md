# Built-in PostgreSQL tool

The `sql` tool consumes `ctx.databaseConnections`; it needs no MCP server. It is installed in the default base bundle, but is absent from the model's tool list until at least one connection has **Let the model query this database** enabled.

## Operations

Choose the database using the exact saved connection name. `list_tables` lists user-visible `schema.table` names. `describe_table` accepts `table` and returns column name, PostgreSQL type, nullability and primary-key membership; quote mixed-case identifiers as in SQL. `execute_sql` accepts SQL text and returns rows. SQL is not restricted to reads: all authority comes from the PostgreSQL account. Grant model access only to accounts with the intended permissions.

The owner toggle controls the schema enum and is checked again at execution time. A rename or toggle rebuilds the tool definition. Every call opens a dedicated client, honors caller cancellation, and closes the client and any SSH forward in `finally`. Native and PTC execution both use the existing tool registry.

## Output

Rows are newline-separated JSON. `maxRows` defaults to `200`; `maxCharacters` defaults to `32000`, including a reserved summary budget. Excess rows are discarded while the driver completes the query, so the footer reports the total rows, returned rows, affected/reported rows and whether truncation occurred. Query results are not silently rewritten with a LIMIT clause. A single overlong row is omitted rather than cut into invalid JSON. Errors use the existing tool error rendering. The generic tool card displays the call arguments and result.

## Model Experience

Enabling the first connection adds one tool schema. Connection-name changes alter that schema and can affect prompt caching. Only enabled connection names appear; credentials and network settings are not added to the model prompt. Results consume tokens up to the configured retention bounds; truncation is explicit.

## Known Limitations and Deferred Work

Counting total rows requires reading the complete query response, even when only a small prefix is retained. PostgreSQL may still spend substantial time or memory on the query, and a single row is decoded before the output cap can discard it. Cancellation disconnects the client and cannot undo already committed SQL; review database state before retrying a write. A transaction must fit in one call because handles are not shared across calls. No live database or SSH validation is part of this delivery.
