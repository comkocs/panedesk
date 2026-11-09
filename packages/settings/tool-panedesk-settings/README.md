# @panedesk/dsh-tool-panedesk-settings

English | [中文](README.zh.md)

## Summary

The `panedesk_settings` tool reads editable Panedesk preferences and writes one named item through the same revision-fenced `settings.mutate` path as the settings pages. It is included once in the base bundle and inherited by Web session presets. `read` returns current values and the Schemastery allowed-value schema; `write` returns the previous and persisted values.

## Use

Call `panedesk_settings` with `action: "read"`, then copy an exact returned `name` into a call with `action: "write"` and its JSON `value`. Available fields are opening-name enablement and anchor rules, statistics enablement and refresh interval, the external registry path and enablement, global filesystem-skill scan controls, node refresh cadence and a uniquely configured transport's enablement, and data-storage settings. Skills and transport fields reuse the pages' `configEditor.edit` path; storage reuses `postgresStorage.save` and reports restart requirements. Only mounted editable namespaces appear. Read calls may run concurrently; writes are exclusive.

The Tools page and this tool share `disabledTools`, an array of tool names. Its validated default omits `subagent_fork`, `workflow`, `create_goal`, `update_goal`, `get_goal`, `present`, and `ask_user_question`, including before any settings are saved. An empty array enables all available tools. Each ordinary session captures the list at its first model assembly; later edits apply to new sessions. Typed subagents advertise their mapped tools. Untyped subagents advertise the working tool set plus names explicitly supplied by `subagent.extra_tools`; browser and MCP tools are not included by default. The `subagentsFullTools` switch defaults to false and restores the full available set for new untyped children when enabled. This is a model-presentation preference, not an execution permission: native schemas and PTC SDK entries are omitted without changing tool registration or guards.

## Model Experience

The tool adds one schema to the model request and returns JSON text. Values and write results are recorded as ordinary tool results; no prompt section or extra model request is added. Existing settings schema validation and revision conflicts remain authoritative.

## Known Limitations and Deferred Work

Project opening, database connections, worker profiles and other settings without a callable shared writer are manual-only and are not advertised as editable items. No owner identity is synthesized to call owner-only Remote methods.
