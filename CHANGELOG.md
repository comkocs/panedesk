# Changelog

## 2.0.0

### Added

- A per-project trace store: each project can turn on trace recording (off by default; turning it on lets any window of the project write to its local SQLite trace database), which automatically records session and agent starts and ends, message delivery and receipts, deliverables and change summaries with durable diffs, without copying transcripts.
- Trace tools for models (items, timeline, references, comments, session linking, decisions) and a read-only `trace` CLI that exports items as JSON or Markdown.
- A Trace panel with items, timeline, unassigned activity and export, and a Decisions view with provenance, history and revert, plus an optional strict mode where decisions are proposed by a designated planning window and confirmed by the user.

### Changed

- Verification switches move into the project trace database when trace recording is on.

## 1.9.0

### Added

- Activity categories with live "now doing" time per agent in the agent tree, a per-category time table for each run, the whole tree and the main session, and per-workspace custom command rules.
- Per-workspace Verification settings (full test runs once per turn by default, mutation tests off, presets Default / Unlimited (count only) / Build only, an optional verification time budget and a wait limit for launching clients) enforced before tool execution, with a "No more tests" switch on running agents in the agent tree.
- A verification checklist tool and a Verification panel in the right sidebar where unchecking an item blocks that kind of check for the task.

## 1.8.6

### Added

- A Model API entry in the sidebar, between New Session and Plugins, opens model settings.

### Fixed

- The settings dialog body scrolls and the dialog stays within the window.
- Clicking an agent in the agent tree shows its details and can open its session in the right sidebar.
- Widening the window for the right sidebar grows to the right first and stays within the screen.
- Batch-pasted opening presets get an inferred folder or the current workspace, the added count shows next to Batch paste, and models that share a name are labeled with their IDs.

### Changed

- The right panel first opens at 17% of the window instead of 45%.
- The main window first opens at twice the previous default size, within 90% of the screen.

## 1.8.5

### Fixed

- New Session and Ctrl+N no longer restore an idle stored blank session first, and picking a dated session title reads cached titles instead of every stored session log, so starting a session waits less as sessions accumulate.

## 1.8.4

### Fixed

- Sessions named from an opening preset before their first message no longer make the stored log unreadable, so creating sessions and choosing presets work again after updating, and preset sessions are titled with the preset name and date.
- Pasted images stay in a session's unsent draft when switching sessions.
- Shift-click in the sidebar selects a range starting from the open session.
- New sessions start in the open session's workspace.
- A provider's Edit opens its model settings, and every listed model offers a protocol probe.

### Changed

- The opening preset editor has one folder with Change folder, pickers for model, reasoning effort and permission, no blank card on open, and stays open when clicking outside.
- Settings buttons are sized to their labels.
- The mode picker group is named Built-in modes.
- Agent sessions opened from the agent tree or map open in the right sidebar and widen the window instead of narrowing the main session.

## 1.8.3

### Added

- The agent map zooms around the cursor with the wheel, pans by dragging empty space, and has Fit / 100% / + / − controls.
- Sidebar sessions can be multi-selected with Shift and Ctrl or Cmd to pin, unpin or archive them together, with one undo action for a batch archive.

### Fixed

- Stopping an agent from the agent map works the same way as from the agent tree.
- Agent types start on providers that declare no reasoning efforts.
- The protocol probe button responds, and probe and connection failures show the category, HTTP status and raw response with credentials masked.
- Opening presets keep split names, support undo and clearer drag previews, and remain editable when the list is empty. Workflow entries can be changed or deleted with in-place save feedback, and the workflow trim tool prints UTF-8 output.

### Changed

- Workflow starters sit above the welcome title, which now reads Panedesk.
- Claude Code agent types from `.claude/agents` are read only when the new setting is on (off by default), and the four built-in modes are listed as built-in modes.

## 1.8.2

### Fixed

- Saved opening presets show up again in the editor and the new-session menu.
- New sessions no longer wait for the browser MCP client, repeated clicks do not create extra sessions, and eligible empty sessions are reused.
- Agent types pick a provider that supports their effort and explain why others were skipped, including when a lower effort is used.
- The workflow pack is unpacked so its tools can run in the desktop app.

### Changed

- Statistics cards wrap in narrow windows; subagent cards separate current context from cumulative usage, identify the parent session, and distinguish stopped from completed agents; context percentages use consistent rounding and clearer estimate labels.
- Protocol probes can expand failure details and explain undeclared image support; model lists have clearer names and identify providers for duplicate models; the first-screen workflow entry can be changed; opening-name extraction highlights the selected option.

## 1.8.1

### Fixed

- Dialogs stay inside the window, keep their title and buttons visible and scroll their content.
- Pasting several lines into an opening message splits them into presets, and presets are reordered by a drag handle or move buttons.

## 1.8.0

### Added

- New-session workflow and opening-preset menus fill an unsent draft. Settings can edit workflow prompts and manage or import saved opening text, folders and optional model and permission choices.
- A Tools settings page lists available tools with switches and approximate context costs, and can restore the full tool set for untyped subagents.
- The context panel groups usage by category, lists individual contributors and deferred tools, shows compaction headroom and links to Tools settings.
- The workflow pack includes requirements review and workflow checkup entries; opening reads are trimmed to the opening guide, project rules and constitution, and new projects start with two sessions. Built-in features now describes the 1.8 defaults and where to find the new entries.

### Changed

- Panedesk uses a dark theme by default; saved appearance choices are unchanged.
- Six optional tools are off by default, question cards remain available, only the selected command tool is mounted, and plan exit is offered only in plan mode. Tools settings can turn optional tools back on.
- Untyped subagents receive working tools and explicitly requested extras by default; typed subagents keep their mapped capabilities.
- Model context limits use upstream listings, model-name presets or manual entry, with the source shown in Models. Automatic compaction starts with 5.5% of the context window remaining.
- Chrome DevTools is enabled by default. Its tools remain loaded rather than deferred, and connection failures do not block other tools.
- Project opening defaults to Automatic while retaining saved choices and the existing cost confirmation. Settings actions are easier to see and the settings title row can be dragged.
- The cache pill is hidden unless turned on in settings.
- The session header shows a Statistics text button. Running background jobs and subagents show solid green dots in their header lists.

### Fixed

- Typed subagents now get the standard tools, and an ambiguous agent model picks the first provider in Models settings order.
- The browser tool works in the desktop app.
- The command tool is named `bash` when Git Bash runs it, including when an older unversioned shell preference exists.
- Agent-opened sessions land in their folder group.
- Finished background jobs and finished subagents show a grey dot without a stop button.
- Subagent cards distinguish current context from cumulative usage, and provider usage is normalized before context and ledger accounting.
- Subagents wait longer for the local ledger lock and, if they still stop, tell the parent session and their card why.

## 1.7.0

### Added

- Agents can open a session in any folder with a chosen model, permission level and opening message, rename sessions, list top-level sessions and send a message to another session. The message waits if that session is busy and shows which session sent it.
- A Stop button in the agent map, its detail pane and the agent tree stops a running subagent together with its descendants, a background shell task, or a controllable externally registered agent. `interrupt_agent` can stop descendants with `includeDescendants` too.
- A Browser button in the session header opens the sidebar browser, and agents can drive the same browser with a `browser` tool: open pages, read page text, take screenshots, click, type, scroll and switch tabs. Connecting your own Chrome through Chrome DevTools can be turned on in settings.
- Model settings can test a model against the OpenAI Chat Completions, OpenAI Responses and Anthropic Messages protocols, checking text, streaming, tool calls and images, and save a protocol whose text check works.
- Each Panedesk settings page starts with what it is for, whether you need to change anything, and a request to paste into a session where agent help is available. A built-in `panedesk_settings` tool reads and changes the editable preferences it lists and reports before and after values; owner-only management actions remain manual. A new Built-in features page lists what Panedesk does on its own.
- New sessions read the Claude Code memory index for their folder from `~/.claude/projects/<folder>/memory/MEMORY.md`, when it exists.

### Changed

- Subagent types from `.claude/agents` map Claude Code tool names such as Read, Write, Edit, Bash, Grep, Glob, WebFetch and `Agent(...)` to Panedesk tools, and tools outside those capabilities are no longer refused for that reason.
- When a subagent cannot reach its model, the parent session and recorded failure details in the agent map show available HTTP status and the start of the response, with keys masked.
- Agent tree rows, agent map cards and sidebar sessions show a status dot, green while active and grey otherwise. Model names are colored by family, and subagent cards show the model actually used.
- Right-clicking a session or folder in the sidebar opens its menu; folders also offer New session here.
- Model recognition lists the models already added as checked, and Save adds the newly checked ones and removes the unchecked ones.
- The opening-name setting accepts selections with spaces and has buttons for the folder name, the file name before `.md`, and everything after `.md`.
- The statistics panel stays inside the window with a fixed header and filters, shows totals first, pages the call list and shows durations in minutes.
- Compaction follows the Compact Instructions section of CLAUDE.md and CLAUDE.local.md files, and Claude Code hooks from project and user settings run by default, including SessionStart after compaction.
- On Windows, Git Bash is used by default for commands and the terminal when it is found and PowerShell has not been chosen.

## 1.6.1

### Fixed

- In 1.6.0, the project opening settings plugin could fail to activate at startup and show "Application failed to start".
- Startup failure reports now include the reason for each plugin that failed to activate.

## 1.6.0

### Added

- An agent map button between the permission and model pickers opens a compact map of the session's subagents, expanding from the session in the middle, with background shell tasks in the corner. Selecting an agent shows its task and can open its session.
- The Database connections settings page stores PostgreSQL connections from a connection string or separate fields, with SSL, an optional SSH tunnel and a connection test. Passwords and key passphrases are kept in Panedesk credentials.
- Panedesk data can be stored in a saved PostgreSQL connection, in its own `panedesk` schema. Existing local data can be copied over, and Panedesk falls back to local storage when the database cannot be reached. Ledger rows are written there too and the statistics panel reads them.
- A saved connection can let the model query it through a built-in SQL tool that lists tables, describes columns and runs SQL.
- MCP servers configured for Claude Code in the project's `.mcp.json` and in `~/.claude.json` are loaded as well; Panedesk's own entries win on name clashes.

### Changed

- Completed agents in the agent map show a grey dot.

## 1.5.0

### Added

- The session header has a statistics button that opens charts of token use by model, daily usage and a subagent call timeline, filtered by project and session.
- Hovering a subagent in the header list shows its task: status, model, duration, tokens, a prompt summary and recent tool calls.
- Skills are also read from `.claude/skills` in the project and in the home directory; the Skills page lists every scanned directory with its path, status and skill count.
- Custom provider models get reasoning levels inferred from the model: GPT, o-series, Claude and Grok models offer low, medium, high and xhigh, defaulting to high; image and audio models offer none. Each model row shows its levels and can change them.
- New sessions are named from the folder of the path in the opening message, or from a chosen part of it, followed by the creation date; repeated names on the same day get (1), (2). Untitled sessions also show the date.

### Changed

- Panedesk settings pages share one layout: a description, the switch and its default, the configuration file path with an Open button, and the adjustable options. DSH settings pages each start with a one-line introduction.
- The external subagent registry setting has a file picker and an on/off switch.
- Node connections are off by default and are turned on from their settings page.
- Model discovery checks only the newest model of each family by default, comparing version numbers. Custom model APIs are listed first and DeepSeek last.
- Completed subagents show a grey dot instead of a green one.
- The subagent tree shows a session as idle when no turn is running, instead of always running.

### Fixed

- DeepSeek model discovery requested the wrong endpoint and failed with HTTP 404.
- Agent presets imported from `.claude/agents` failed to load in the installed app.
- The opening-name setting row was missing from the Panedesk features page.

### Removed

- The Inbox button and panel in the session header.

## 1.4.0

### Added

- The subagent tool can start a child on any model configured in Panedesk by model name, or by an agent type from `.claude/agents`, in new and existing sessions alike.
- Settings has a Panedesk features page. New sessions can be named from a chosen part of the opening message plus the local date (for example `UI Controls 11-8`); otherwise the automatic title gets the session's start date.
- The subagent tree can list subagents recorded in an external JSONL registry file set on the Panedesk features page; shell commands receive `CLAUDE_CODE_SESSION_ID`.
- Messages sent while the agent is running wait below the conversation and are delivered after the current tool step in the same turn; a queued message can be withdrawn or sent immediately.

### Changed

- The sidebar and running status show the Panedesk mark instead of the upstream whale.
- The sidebar's More menu is replaced by a Settings button; Feedback and Sign in are removed.
- Settings navigation shows General, Models, Panedesk and DSH; upstream pages are grouped under DSH and Panedesk pages under Panedesk. Clicking outside Settings no longer closes it.
- All models accept text, images and files by default; attachments are no longer blocked before sending, and model input types list text, image, file and audio.
- Adding a model API opens the custom API form first, and custom providers no longer ask for a Provider ID.

### Removed

- The subagent model selection setting, now unnecessary.

## 1.3.0

### Removed

- Panedesk's extra protection layers on top of upstream DSH are removed; file access, subprocess, seat, credential and session behavior follow upstream again.

### Added

- Subagents can be dispatched by the agent types defined under `.claude/agents`.
- Subagent reports include the child session id and the model actually used.
- Child processes receive `PANEDESK_ENTRYPOINT`.

### Changed

- File tool write errors name the step, the path and whether it was denied or a system call failed, in English and Chinese.
- New sessions default to workspace-write access on every platform, as upstream.

## 1.2.1

### Fixed

- Models added from recognition are now saved when creating a custom provider.
- Requests to non-Claude models through Anthropic Messages gateways carry session metadata even when no cache option is set.

## 1.2.0

### Added

- Model recognition keeps the latest two models of each family.
- Custom provider forms fetch available models automatically once the base URL and API key are filled in.
- DeepSeek providers support model discovery, and providers without discovery no longer show the discover button.
- The model recognition panel explains what was selected and how to add more.
- New sessions remember the permission preset you last picked.
- Session titles refresh from recent rounds as a conversation goes on.

### Changed

- Requests to non-Claude models through Anthropic Messages gateways carry Claude Code style session metadata, so gateway prompt caching can hit.
- The empty new-session page shows the Panedesk mark.

## 1.1.1

### Fixed

- Windows startup failed with EPERM fsync when relocating a legacy credentials file.
- Writing a new file on Windows failed with a sharing violation when a parent folder was open as another program's working directory; a file that is genuinely in use now reports which file to close.

## 1.1.0

### Added

- The first-run welcome page links to Settings → Models → Add model provider through “Use another provider”.
- Unsigned Windows installations check comkocs/panedesk GitHub Releases for updates and prompt before downloading and installing. Version 1.0 has no update source, so install 1.1 manually once.
- The inbox explains and logs when data directory permissions are too broad.

### Fixed

- Subagent presets reported as "Unknown agent preset" when validated in the same activation turn.
- Update prompts opened from the account row downloading without confirmation.

### Changed

- Updated known limitations to identify the inherited Agent Teams issue and remove resolved issues.
- The run-gates development script accepts `--base` and file arguments to skip checks unrelated to changed files.

## 1.0.0

### Added

- Panedesk and pdesk launchers with slim-by-default profiles, optional full compositions and interactive provider setup.
- Session ledgers, subagent monitoring, statistics, node administration and opt-in seat orchestration in the Web composition.
- Authenticated owner approval, protected credential storage and Linux connection-source admission.

### Changed

- Disabled telemetry and product analytics by default and separated Panedesk branding from upstream DeepSeek Harness.
- Anchored Linux file operations to directory descriptors and enabled the Windows experimental handle backend by default.
- Reduced repeated protected-root scans during startup and preserved approved input state across restarts.

### Known limitations

- Windows console sharing and incomplete network isolation require separate OS accounts for untrusted tasks and Web-based owner approval.
- macOS path-based writes and unverified native platform enforcement remain restricted; see [platform behavior](docs/user/platform-behavior.md#platform-behavior).
- Windows file replacement permissions need care; follow [known limitations](README.md#known-limitations).
- Windows native builds are not byte-for-byte reproducible; use distributed artifacts with their supplied checksums.
