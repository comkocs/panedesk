# DeepSeek Harness Architecture

English | [中文](architecture.zh.md)

Read this before changing anything under `packages/`. It assumes you know Cordis; if you do not, start with the [primer](cordis-primer.md) or the [tutorial](cordis-tutorial/index.md).

## Cordis

[Cordis](cordis-primer.md) is the framework under dsh: plugins contribute services, typed events, and reversible effects to a shared context. Every part of the product is a plugin, including the model adapter, the tool registry, the session log, and the agent loop itself, so each is replaceable from configuration.

There is no privileged core to patch: you extend dsh by mounting a plugin beside the others, and registrations are effects that unwind when their plugin unloads.

## Profiles and bundles

A running `dsh` is a plugin tree composed at boot from ordered layers.

A **profile** is a named Harness-home composition owning its ordered bundles, installed external plugins, and `cordis.patch.yml`.

A **bundle** is a distribution format for Cordis config rows and the code they mount, so whatever it inserts stays patchable by the layers above it.

Each declares itself in its own `package.json` under a `dsh` field: `dsh.profile` lists a profile's bundles, and `dsh.bundle` points at a bundle's patch file.

[`dsh-base`](../packages/bundle/base/README.md) is the shared first layer of the `web`, `headless`, `sdk`, and `acp` profiles: model adapters, tools, persistence, sandbox and approval policy, settings, credentials, telemetry. [`dsh-web-app`](../packages/bundle/web-app/README.md) adds the browser application, [`dsh-headless`](../packages/bundle/headless/README.md) adds a one-shot runner with no server, [`dsh-sdk-app`](../packages/bundle/sdk-app/README.md) adds the SDK JSON-RPC server, and [`dsh-acp-app`](../packages/bundle/acp-app/README.md) adds the automation-only ACP server. [`dsh-sdk-minimal`](../packages/bundle/sdk-minimal/README.md) is the deliberate exception: one bundle owns its complete explicit SDK tree and does not apply `dsh-base`.

Layers apply to an empty entry list: the profile's ordered bundles, its `cordis.patch.yml`, the home patch, then `--patch` overlays. A patch targets a row by id and replaces its whole config, or inserts new rows. A `preset` patch applies these operations inside that declaration’s `config.plugins`, with the same layer precedence.

YAML controls HMR: base enables config-only `dsh-hmr`; headless, SDK and ACP disable it; `sdk-minimal` omits it. Profile patches override these defaults. HMR coordinates watching and reloads; the launcher provides profile data and readiness.

Base includes [Plugin Manager](../packages/boot/plugin-manager/README.md) for Web and agents.

To see the tree your machine boots:

```sh
dsh --profile web --dump-config
```

Any row it prints can be replaced by a patch of your own.

Composition mechanics are in [app-boot](../packages/boot/app-boot/README.md#profiles); config fields are in the generated [config catalog](config-catalog.md).

## Application launch

Supported Node applications launch through named `dsh` profiles selected with `dsh --profile <name>` or `dsh <name>`; see [app-boot](../packages/boot/app-boot/README.md#profiles) for templates. `plugin` is the management command, so that profile requires `--profile plugin`. The TypeScript SDK resolves same-version `dsh` and selects `sdk`; custom compositions use profiles and ordered patches, never separate executables or inline trees. `sdk-minimal` is a repository-owned standalone bundle.

Vendored CLIs, build-only and test-only executables, direct in-process plugin mounting, and the private browser WebWorker preview are not Harness application launchers. [`verify-application-entrypoints`](../scripts/verify-application-entrypoints.ts) keeps every package bin, executable source, root demo, and the root `start:web` and `dev:web` scripts in an explicit class and rejects a Node application path that bypasses `dsh`.

The Python SDK follows the same application architecture. Its runtime wheel packages the normal `dsh` CLI as `deepseek-harness-sdk-runtime-<platform>-<arch>`, and the client launches `dsh --profile sdk` with an explicit Harness home by default. The minimal example selects the shipped `sdk-minimal` profile. Python exposes profile selection and ordered patch files rather than a complete Cordis tree; persistent external plugins are installed through `dsh plugin`. The removed private direct-config carrier has no compatibility bin or fallback parser.

The opt-in `seat` profile adds orchestration without changing other profiles or installing background services. See the [package group](../packages/seat/README.md) and [subsystem semantics](subsystems/seat.md).

## Desktop application

The [Electron desktop application](../apps/desktop/README.md) ships its exact dsh production runtime in signed resources and owns the reserved `$PANEDESK_HOME/profiles/desktop`. Shared helpers initialize profile files, reconcile bundles, and resolve installation and bundle dependencies without replacing pnpm-owned packages. Desktop and npm CLI share product data but keep packages, activation, and lockfiles separate. Desktop’s bundled CLI manages its initialized plugins.

Electron starts the private Desktop Host in Electron Node mode. The Host invokes the shared CLI profile runner and complete Web application. The window immediately loads packaged Web assets and waits for boot injections before activating client plugins in the same document. Web owns RPC and streams; the desktop carrier connects the local page to the authenticated Host. Node IPC carries boot injections, readiness, fatal errors, and shutdown. Desktop listens on an OS-assigned port by default; profile configuration can override it. Shell-owned UI runs plugin transactions through bundled pnpm with normal user and profile configuration.

## Core packages

| Package | Owns | `ctx` key |
|---|---|---|
| [`core/session`](subsystems/session.md) | The append-only `SessionEvent` log and in-memory store | `ctx.sessions` |
| [`core/system-prompt`](subsystems/system-prompt.md) | Prompt-section and tool-schema assembly | `ctx.systemPrompt` |
| [`core/tools`](subsystems/tools.md) | The scoped tool registry and guarded execution pipeline | `ctx.tools` |
| [`core/agent`](subsystems/core.md) | The `Agent` interface, live registry, and `agent/*` events | `ctx.agents` |
| [`core/agent-loop`](subsystems/core.md) | The default driver implementing that interface | `ctx.agentLoop` |
| [`core/scope`](subsystems/scope.md) | The per-agent scoped-registration primitive | library, no key |
| [`llm/llm`](subsystems/llm-streaming.md) | Message and stream vocabulary plus the adapter seam | `ctx.llm` |

## Events

Events are the extension points, and picking the right domain is the first decision in most changes.

- **Session events** are durable facts appended to the log and broadcast through `session/event`. Use one when the fact must survive a reload.
- **Agent events** (`agent/*`) carry a live `Agent`: inbox, step, status, request, validation, continuation. Use one to observe or intercept work in flight.
- **Capability events** attach policy and adapters to a seam (`fs/*`, `tools/*`, `telemetry/*`) without importing the loop.

`agent/create-admitting` precedes factory effects; failed preparation is released. `agent/turn-admitting` can defer queued work until `wake()`. AgentLoop awaits serial `agent/created` before work, takes over prepared ownership, and rolls back failed initialization. Unload retains resources through teardown; [agent-loop](../packages/core/agent-loop/README.md#understand-the-implementation) defines ordering.

The [event map](event-producer-consumer.md) lists every event's producers and consumers.

## Turn flow

[Agent-loop](../packages/core/agent-loop/README.md#use-this-package) establishes lifecycle accounting before publishing an Agent, reusing matching unfinished caller-written starts with debug-only field-difference diagnostics.

A **step** is one model request plus the tools it calls. A **turn** is zero or more steps: it opens before its first input is claimed and closes once nothing is owed.

```text
turn/start
  await agent/input-preparing -> claim eligible input (reserve scheduled messages)
  assemble prompt sections + tool schemas
  -> agent/pre-step; project runtime context at fallback
                                     reject | enter(messages, startsRequestSeries?)
     reject, or a first enter rewritten empty -> close the turn with no step
     step/start
     agent/request -> prepareCall (cancellation commits neither system nor users)
     reconcile system/message using the prepared call capability
     append entered messages as user/message; reconcile retained runtime context
     log request/header and request/context as needed
     derive and freeze model history from the log
     commit input dispatch synchronously -> stream the bound prepared call
       -> llm/stream -> agent/assistant-stream start
       agent/assistant-stream chunk*
       assistant/message | assistant/attempt -> agent/assistant-stream end
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     tools owe another request, or next-step input arrived -> prepare -> claim -> next step
  -> agent/turn-stopping
turn/end
```

`turn/*`, `step/*`, `system/message`, `user/message`, `assistant/message`, `assistant/attempt`, and `tool/*` are durable session events; the rest are live extension points across three domains. `agent/assistant-stream` publishes process-local start, transient chunk, and end frames. The loop commits the complete compact stream as one message or log-only attempt before a committed end frame, and the Web Session-follow adapter is the live event's only remote consumer. `agent/pre-step`, `agent/request`, `llm/stream`, and the three `tools/*` events are waterfalls, whose listeners must call `next()` to delegate; `agent/turn-stopping` is serial and has no `next()`.

One inbox feeds the driver. Scheduled input orders eligible messages by `immediate`, `steer`, then `queue`, FIFO within each priority; `queue` waits for a turn boundary, while `steer` joins the next step without cancelling output. Passive input never wakes or independently continues a turn; eligible passive notices join the next naturally started turn. Legacy `followup`, `steer`, and `inject` retain their scheduling behavior. AgentLoop’s durable `inbox` projection exposes pending input without live Agents.

Serial `agent/input-preparing` listeners may await producers and enqueue before each claim; failure leaves input unclaimed. `agent/input/transition` records claim and dispatch separately. Cancellation before `user/message` append restores identity and FIFO position at the priority's head, allowing withdrawal. After append, synchronous request-construction failure preserves history and claimed state without surface replacement or requeue. The next containing request commits first dispatch and emits `agent/input-dispatching` immediately before stream entry, without intervening await. Dispatch means local entry, not remote receipt.

`agent/pre-step` may rewrite or reject input and declare `startsRequestSeries`; wrapping listeners preserve the decision. A rejected or empty first claim closes the turn without a step. After `step/start`, `agent/request` and `prepareCall()` resolve the route before committing system or user messages. Cancellation during preparation commits neither. Requests derive from logged history; retries reuse assembly without repeating pre-step or user admission. [Agent-loop](../packages/core/agent-loop/README.md#understand-the-implementation) owns capability-dependent prompt reconciliation, runtime context restoration, and request-series rules.

The loop sends immutable requests with live cancellation and reuses freeze evidence for frozen identities. Active `immediate` input interrupts only its target agent's current turn with `interjection`, preserves queued input and partial assistant output, and resumes with priority; it does not cancel children or background jobs. Idle input causes no empty cancellation. [Agent-loop](../packages/core/agent-loop/README.md) owns construction and cancellation causes.

Failed steps [record missing tool results](../packages/core/agent-loop/README.md#understand-the-implementation). Interjection retains completed results and settles started calls with their available output and cancellation detail; undispatched calls receive skipped results. Each recorded call has one result, and unknown external side effects are not described as rolled back. Cancellation still waits for started tools to settle.

[Local message delivery](../packages/session/message-delivery-local/README.md) publishes same-node sends and controls as atomic mailbox files. The recipient's lease-holding host alone arbitrates admission and withdrawal. Closed recipients retain pending mail; resume applies controls before claiming input. Durable receipts precede notifications, and message-ledger records remain separate from call accounting. SDK, ACP, and CLI extensions share this service; new sends default to steer, while legacy prompt methods retain their behavior.

Details: the [sequence diagram](agent-lifecycle.md), the [tool pipeline](tool-execution-pipeline.md), and [cancellation and error recovery](subsystems/core.md#the-agent-handle).

## Session log

The session log is the source of the context the model sees. `deriveMessages()` projects model history from it. Each `assistant/message` embeds the exact compact timed stream that produced its assembled content; `assistant/attempt` retains settled failed, retried, cancelled, and stream-error attempts without adding model history. Fork, resume, transcripts, telemetry, and persistence all derive from these durable settlements, while live UI incrementality comes from `agent/assistant-stream`; a hard process loss before settlement leaves no durable attempt stream ([decision](../.agents/notes/implemented/architecture/2026-09-01-v2-embedded-assistant-streams.md)).

Session consumers use the current logical format. The [JSONL provider](../packages/session/session-persistence-jsonl/README.md) selects the highest canonical generation and owns framing, compression, and exclusive publication. Adjacent migration packages translate historical data; read opens do not publish, while write opens publish a verified successor beside unchanged history. Future versions are refused, and committed generations are never replaced or deleted ([decision](../.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md)).

**Model-visible means logged.** Every model request must be reconstructable from the log. New model-visible inputs require session events. Plugins changing existing message content register [pure message projections](subsystems/session.md#plugin-owned-message-projections); detached readers supply the same definitions explicitly. Tool changes are capability-independent; [Session tool history](../packages/core/session/README.md) supplies provider declarations.

**Projection seam.** `dsh-session-projection` owns `ctx.sessionProjections`: registered units fold committed events incrementally, host consumers read one typed state with `stateOf()`, and carriers batch cropped client views with `snapshot()`. A host reader either requires this service during activation or fails explicitly when the registry or required key is absent. Contributors may retain `ctx.inject(['sessionProjections'], ...)` registration without silently defaulting a missing host value. The agent loop registers shared `turnBoundary` state for its readers ([decision](../.agents/notes/implemented/architecture/2026-08-19-session-projection-mandatory-seam.md)).

[Working directories](subsystems/working-directory.md) supply user context and execution paths without changing original project identity, sandbox write roots, or existing process directories.

## Capability seams

A **seam** is a swappable capability with three roles: a **Service Definition** declaring the interface, a **Service Provider** implementing it, and a **Consumer** using it, commonly a model-facing tool. A package may combine roles, but one role alone is not a seam; adding a capability means designing all three ([capability graph](capability-seams.md)).

Seams are why one provider swap changes the whole product. Filesystem and subprocess providers share one execution world, so pointing them at a remote sandbox moves Bash, PTY, and LSP with them, with no provider forks. [Subagent providers](subsystems/subagent.md) vary just as widely behind one interface, from a fresh child agent to a delegated turn in another product.

[Experimental Agent Teams](subsystems/agent-team.md) exposes opt-in `ctx.agentTeams` coordination with durable roster and task state plus direct inbox messaging over continuable subagents.

## Where new behavior goes

New behavior attaches to a documented extension point. Changing the loop itself updates this map.

| Goal | Mechanism |
|---|---|
| Add a model provider | register its adapter on `ctx.llm` |
| Add a model-facing capability | register on `ctx.tools`; its schema joins prompt assembly |
| Give one session a different capability set | compose an agent preset; a service row there needs an `isolate` realm |
| Add shell execution | register a `ctx.shell` backend; the local one spawns through `ctx.subprocess` |
| Add persistent terminal execution | register a `ctx.terminals` backend plus `dsh-tool-terminal` |
| Add a human command | register on `ctx.commands`; it dispatches without a model turn |
| Manage background jobs | register on `ctx.jobs`; `job_*` tools read or stop jobs |
| Start a Session from an external webhook | register a trusted rule on `ctx.webhookRuntime` and mount a provider adapter |
| Add filesystem access or policy | register a `ctx.fs` provider or listen to `fs/*` events |
| Confine spawned processes | use a `ctx.sandbox` backend; consumers wrap argv before spawning |
| Intercept a request, tool, or turn | use its `agent/*` or `tools/*` event; `agent/turn-stopping` stops a turn |
| Add model-facing context | call `agent.inject()`; it lands in the next admitted request |
| Add UI or editor integration | drive `ctx.agents` and render from `session/event` |
| Add a Web Client Chat node | register a `ConversationNodeDefinition` + keyed renderer |
| Add durable session state | extend `SessionEventMap`; render and replay from the log |
| Generate session titles | register the sole `ctx.sessionTitle` provider |
| Manage a same-session objective | use `ctx.goals`; continue through `agent/*` |
| Fork a session at a turn boundary | `ctx.agents.create({ sessionId, seed, meta: { parentSession, seedLength } })` — only agent-loop-published sessions persist |
| Store sessions in a new backend | implement `SessionPersistence` (`create`/`open`/`stat`/`list`/`export`) over the shared handle scaffolding |
| Scope a registration to one agent | use that agent's `agent.ctx` |

The [extension cookbook](cookbook/extension-cookbook.md) maps features to capabilities and indexes the step-by-step guides for [packages](cookbook/adding-a-package.md), [tools](cookbook/adding-a-tool.md), [LLM adapters](cookbook/adding-an-llm-adapter.md), and [settings pages](cookbook/adding-a-settings-card.md). The [Conversation subsystem](subsystems/conversation.md) owns Chat-node assembly.
