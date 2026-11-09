# @panedesk/dsh-tool-panedesk-settings

English | [中文](README.zh.md)

## Summary

The `panedesk_settings` tool reads editable Panedesk preferences and writes one named item through the same revision-fenced `settings.mutate` path as the settings pages. It is included in the base bundle and Web session presets. `read` returns current values and the Schemastery allowed-value schema; `write` returns the previous and persisted values.

## Use

Call `panedesk_settings` with `action: "read"`, then copy an exact returned `name` into a call with `action: "write"` and its JSON `value`. Available fields are opening-name enablement and anchor rules, statistics enablement and refresh interval, the external registry path and enablement, global filesystem-skill scan controls, node refresh cadence and a uniquely configured transport's enablement, and data-storage settings. Skills and transport fields reuse the pages' `configEditor.edit` path; storage reuses `postgresStorage.save` and reports restart requirements. Only mounted editable namespaces appear. Read calls may run concurrently; writes are exclusive.

## Model Experience

The tool adds one schema to the model request and returns JSON text. Values and write results are recorded as ordinary tool results; no prompt section or extra model request is added. Existing settings schema validation and revision conflicts remain authoritative.

## Known Limitations and Deferred Work

Project opening, database connections, worker profiles and other settings without a callable shared writer are manual-only and are not advertised as editable items. No owner identity is synthesized to call owner-only Remote methods.
