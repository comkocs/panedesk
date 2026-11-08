# SessionTelemetryBackend

English | [中文](session-telemetry.zh.md)

The [capture service](../../packages/session/session-telemetry/README.md) owns canonical-event capture, redaction, and handoff cursors. The [feedback backend](../../packages/session/session-telemetry-otel/README.md) authorizes Session prefixes and owns their independent queue, per-request scheduling, and 4,000,000-byte ceiling. No reporting data reaches model requests.

Source: [`packages/session/session-telemetry/src/index.ts`](../../packages/session/session-telemetry/src/index.ts)

## The logical record

```ts type-equiv
/**
 * Severity of a telemetry record, pre-mapped at capture so a receiver can
 * alert with zero configuration: `error` for events whose own outcome flag
 * says so (the tool message's `isError`, `turn/end` error reasons) and for
 * `agent-error` operational records. Captured events otherwise default to
 * `info`; `warn` remains available to `session-telemetry/record` policies and
 * backends.
 */
type SessionTelemetrySeverity = 'info' | 'warn' | 'error'
```

```ts type-equiv
/**
 * One logical record handed to a backend — the capture contract's whole outbound
 * vocabulary. Ledger records mirror session-log events one-to-one;
 * operational records (`channel: 'ops'`) carry the two signals with no log
 * home (`agent-error`, `shutdown`) and deliberately omit `event.seq`-style
 * identity so they can never be mistaken for ledger rows.
 */
interface SessionTelemetryRecord {
  /** Canonical envelope without data; body carries the separately redacted payload. Absent for operational records. */
  sourceEvent?: { sessionId: SessionId; envelope: Omit<SessionEvent, 'data'> }
  /** Ledger (session-log mirror) or ops (operational signal) channel; backends keep the two under separate instrumentation scopes. */
  channel: 'ledger' | 'ops'
  /** Unix epoch milliseconds — the source event's append time for ledger records, the emission time for ops records. */
  time: number
  /** Pre-mapped alerting severity; see {@link SessionTelemetrySeverity}. */
  severity: SessionTelemetrySeverity
  /**
   * Identity attributes, deliberately minimal: ledger records carry
   * `session.id`, `session.format_version`, `event.type`, `event.seq`, plus optional
   * `session.cwd` / `session.parent_id`; a seeded Session also carries
   * `session.seed_length` from its exact inherited event count;
   * ops records carry `telemetry.op`, `session.id`, and (for `agent-error`)
   * `agent.id`, `turn`, `step`, `error.name`. Anything recoverable from the
   * body is intentionally NOT duplicated here.
   */
  attributes: Record<string, string | number>
  /**
   * The complete payload: a deep copy of the session event's `data` for
   * ledger records (JSON-serializable by `Session.append`'s own
   * validation), or the op payload for ops records. Never mutated after
   * handoff.
   */
  body: unknown
}
```

Every canonical [session event](session.md), including each `assistant/message` or `assistant/attempt` with its complete compact stream and every plugin-merged type the seam never heard of, passes through whole as one ordered ledger record. Process-local `agent/assistant-stream` frames do not enter this durable feed. A new fork starts at its child-owned suffix, including the inherited marker and fork closers; restored Sessions start after their stored prefix, including restored forks. The backend can select `includeHistory` to include the complete prefix; re-adopting the same object resumes after its handoff cursor. Delivery is best-effort: the cursor marks handed-off, not delivered, and records can be lost (crash, reload window) or duplicated (new-object replay, SDK retries), so receivers dedupe ledger records on `(session.id, session.format_version, event.seq)`; ops records deliberately omit that identity — they are signals to alert on, not entries to sum, and tolerate duplicates instead.

## The sharing disclosure

Every backend exposes its deployment-selected mode through the required abstract `sharing` member on `ctx.sessionTelemetry` ([Service Definition README](../../packages/session/session-telemetry/README.md#the-sharing-disclosure)). This is neither a per-Session admission decision nor a delivery receipt. The `/feedback` acknowledgement does not consult it.

```ts type-equiv
/**
 * Deployment-selected session-sharing mode, not confirmation of SDK delivery.
 */
type SessionTelemetrySharingStatus = 'full' | 'feedback-only' | 'disabled'
```

## Capture policy

```ts type-equiv
/** Whether capture follows live events or reads the canonical log only when requested. */
type SessionTelemetryCapture = 'live' | 'on-demand'
```

```ts type-equiv
/** Backend-selected capture mode and history policy. */
interface SessionTelemetryCaptureOptions {
  /** Follow live events, or wait for explicit capture; defaults to live. */
  capture?: SessionTelemetryCapture
  /** Include inherited fork history and stored history from earlier lifecycles; defaults to false. */
  includeHistory?: boolean
}
```

`includeHistory` permits stored and inherited records but does not itself authorize capture. The [OTel backend](../../packages/session/session-telemetry-otel/README.md) uses on-demand capture and requires new own explicit feedback; it releases only the complete prefix through that feedback, for every provider.

## The backend contract

```ts type-equiv
/**
 * The minimum backend contract the coordinator requires. {@link SessionTelemetryBackend} is
 * its service-registered form; tests compose the coordinator with a bare
 * implementation of this interface.
 */
interface SessionTelemetrySink {
  /**
   * Hand one record to the backend's pipeline. MUST be a non-blocking
   * enqueue — the coordinator calls this synchronously from the
   * `session/event` hot path or an explicit canonical-log capture, so anything
   * slower than a queue push would tax the agent loop or feedback handling.
   * Errors thrown here are contained by the coordinator and logged; they
   * never reach the loop.
   * @param record - the logical record to report; owned by the backend after the call.
   */
  emit(record: SessionTelemetryRecord): void
  /**
   * Optional hint that a turn ended. A backend may forward it to its SDK's
   * flush so records are exported after each turn. Called
   * fire-and-forget; implementations must not block and must not throw
   * meaningfully (the coordinator contains exceptions). Most backends should
   * leave this unimplemented and let their SDK's own batching cadence govern
   * export timing: a backend that does implement it owns the interaction
   * between its concurrent flushes and {@link shutdown}'s drain (the OTel
   * backend leaves it unimplemented for exactly that hazard — see the
   * revival Agent Note).
   */
  flush?(): void
  /**
   * Forward the fiber's disposal to the SDK: flush whatever is queued and
   * reach quiescence, per the SDK's own shutdown contract. Everything
   * emitted before this call must still be delivered — including records
   * enqueued while a {@link flush} hint is in flight, so a backend whose SDK
   * guards against concurrent flushes orders behind the outstanding one (the
   * coordinator emits its dispose-time `shutdown` markers immediately before
   * calling this). Awaited by the coordinator's dispose; a rejection is
   * logged as a warning and never fails application teardown.
   * The coordinator captures dispose-time shutdown markers immediately before
   * this call for live capture; on-demand capture creates no ops records.
   * @returns resolves when the backend's pipeline has quiesced.
   */
  shutdown(): Promise<void>
}
```

`SessionTelemetryBackend` (`ctx.sessionTelemetry`, [signatures](#ctxsessiontelemetry--sessiontelemetrybackend-abstract-seam)) is the contract's loadable form — one implementation per context, duplicate load throws — and a backend composes the seam's `SessionTelemetryCoordinator` in its constructor to install the capture side.

## Ledger statistics

`StatsRequest` selects a fixed range (`today`, `6h`, `24h`, `72h`, `168h`, `all`), a Beijing hour/day bucket and seat/task/model/window/root-child/definition grouping, with optional seat, task and model filters. `StatsView` carries call aggregates, coverage, separate keepalive totals, cache-read fraction, running-session evidence, project/window rows, model summaries, buckets and per-call details from one snapshot. The [query package](../../packages/session/ledger-query/README.md) owns numeric semantics; the [statistics plugin](../../packages/client/ui-stats/README.md) exposes only owner-authorized Remote reads and secondary GUI entries. These are query projections, not persisted Session-format types.

## The redact waterfall: `session-telemetry/record`

Every record passes the `session-telemetry/record` [waterfall](../cordis-primer.md#cordis-waterfall-semantics) between the canonical-event copy and `emit()` ([event entry](#session-telemetryrecord--waterfall)). The seam ships NO rules of its own: with no listener mounted, records reach the backend exactly as captured, so exported data is precisely as clean as the rules a deployment mounts. Listeners stack by transforming `next()`'s return value; returning without `next()` replaces everything beneath; a throwing listener withholds that one record fail-closed inside the coordinator's containment. Redaction applies to the exported copy only — the canonical session log is never rewritten.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxledgerquery--ledgerqueryservice"></a>

### `ctx.ledgerQuery` — `LedgerQueryService`

Query providers read ledger snapshots without launching an Agent or model provider.

```ts cordis-catalog
/** Select and group unique call projections.
 * @param options - half-open time, attribution, and grouping selection.
 * @returns source snapshot and coverage-aware grouped totals.
 */
async query(options: LedgerQueryOptions): Promise<LedgerQueryResult>

/** Compute all five statistics tabs from one deduplicated snapshot.
 * @param request - Fixed range, grouping and time-bucket selection.
 * @param asOf - Optional exclusive UTC millisecond instant; omission reads the system clock.
 * @returns Coverage-aware call totals and child-session lifecycle counts.
 */
async stats(request: StatsRequest, asOf?: number): Promise<StatsView>

/** Compute today's overview at the runtime clock or an explicit observation instant.
 * @param asOf - optional UTC millisecond observation time; omission reads the system clock.
 * @returns Beijing-day totals and node observation coverage.
 */
async today(asOf?: number): Promise<LedgerTodaySummary>

/** Export selected rows in stable time, node, and call order.
 * @param options - selection, format, and caller-authorized destination.
 * @returns output acknowledgement and source snapshot watermarks.
 */
async export(options: LedgerExportOptions): Promise<LedgerExportResult>

/** Execute validated offline command arguments without loading a model runtime.
 * @param args - boot/cmdline inner arguments.
 * @returns structured command output and a conflict-aware exit status.
 */
async execute(args: readonly string[]): Promise<{ code: number; output: unknown }>
```

Source: [`packages/session/ledger-query/src/index.ts`](../../packages/session/ledger-query/src/index.ts)

<a id="ctxmessageledger--messageledgerstore"></a>

### `ctx.messageLedger` — `MessageLedgerStore`

Separate message namespace under the ledger directory; call-journal readers never scan it.

```ts cordis-catalog
/** Resolve the persisted local node identity when provided by this store.
 * @returns Stable identity shared with the full session ledger.
 */
nodeId?(): Promise<LedgerNodeId>

/**
 * Append a runtime-owned fact idempotently, rejecting conflicting event identities.
 * @param event - message namespace envelope with schemaVersion 1.
 * @returns durable acknowledgement cursor.
 */
append(event: MessageLedgerEvent): Promise<MessageCursor>

/**
 * Read only the message namespace with explicit completeness.
 * @param query - filters and exclusive cursor.
 * @returns retained facts and scan completeness.
 */
read(query: MessageQuery): Promise<MessageLedgerPage>
```

Types: [MessageQuery](persistence.md)

Source: [`packages/session/session-ledger/src/types.ts`](../../packages/session/session-ledger/src/types.ts)

<a id="ctxsessionledger--sessionledger-abstract-seam"></a>

### `ctx.sessionLedger` — `SessionLedger` (abstract seam)

Durable ledger contract; implementations alone own storage and runtime hooks.

```ts cordis-catalog
/** Claim compaction facts while leaving physical request accounting with this service.
 * Concurrent owners reject. Without an owner, call accounting records summary facts.
 * @returns Idempotent disposer; capture it in the producing plugin's effect.
 */
registerCompactionOwner(): () => void

/** Register the optional cache contributor on this ledger instance.
 * Concurrent registrations reject, including the same object twice. Capture the returned
 * disposer in the contributing plugin's effect; release prevents future contributions,
 * while calls already prepared retain their contribution through settlement.
 * @param contributor - Cache evidence and admission owner, never a call lifecycle writer.
 * @returns Idempotent disposer releasing only this registration.
 */
registerCallContributor(contributor: CallContributor): () => void

/** Resolve trusted attribution before dispatch.
 * @param request - Explicit session and serving route.
 * @returns Resolved identity and optional frozen reference price.
 */
abstract resolveCallContext(request: { sessionId?: LedgerContext['sessionId'] provider: string model: string }): Promise<{ context: LedgerContext; runId: LedgerRunId; price?: LedgerPriceEntry; priceTable?: LedgerPriceTable }>

/** Bind runtime-owned attribution before publishing a session.
 * @param context - Trusted identity and parent linkage.
 * @returns Disposer removing only this binding.
 */
abstract bindContext(context: LedgerSessionContext): () => void

/** Read an in-memory trusted binding.
 * @param sessionId - Local session identity.
 * @returns Bound attribution, or undefined when absent.
 */
abstract contextFor(sessionId: LedgerSessionContext['sessionId']): LedgerSessionContext | undefined

/** Persist call intent before network dispatch.
 * @param input - Immutable request and attribution facts.
 * @returns Durable append, replay, or conflict outcome.
 */
abstract beginCall(input: LedgerCallStart): Promise<LedgerAppendResult>

/** Commit one terminal call fact.
 * @param input - Observed terminal facts.
 * @returns Durable append, replay, or conflict outcome.
 */
abstract finishCall(input: LedgerCallFinish): Promise<LedgerAppendResult>

/** Persist launch intent before child execution.
 * @param input - Reserved identities and trusted dispatch options.
 * @returns Durable launch intent or conflict.
 */
abstract beginRun(input: LedgerRunStart): Promise<LedgerAppendResult>

/** Compare and set the terminal run slot.
 * @param input - Normal settlement or verified death observation.
 * @returns First committed terminal fact or append outcome.
 */
abstract finishRun(input: LedgerRunFinish): Promise<LedgerAppendResult>

/** Append a uniquely identified runtime fact.
 * @param event - Complete versioned evidence.
 * @returns Synchronized append, replay, or conflict outcome.
 */
abstract appendEvent(event: LedgerEvent): Promise<LedgerAppendResult>

/** Register trusted wait classification.
 * @param toolName - Exact runtime tool name.
 * @param category - Trusted wait category.
 * @returns Disposer releasing only this registration.
 */
abstract registerWaitTool(toolName: string, category: LedgerWaitCategory): () => void

/** Append a contiguous restricted sidecar fragment.
 * @param input - Immutable identity and exact serialized bytes.
 * @returns Durable reference, replay, or conflict outcome.
 */
abstract appendArtifact(input: LedgerArtifactAppend): Promise<LedgerArtifactAppendResult>

/** Close a sidecar durably without changing its contents.
 * @param reference - Last durable fragment reference.
 * @returns Closure acknowledgement for terminal call linkage.
 */
abstract finishArtifact(reference: LedgerArtifactReference): Promise<LedgerArtifactFinishResult>

/** Select projections without counting observations as extra calls.
 * @param filter - Business-time and identity selection.
 * @returns Snapshot with completeness and watermark evidence.
 */
abstract query(filter: LedgerQuery): Promise<LedgerSnapshot>

/** Read a consistent checkpoint view.
 * @param filter - Optional visibility and session restriction.
 * @returns Revisioned snapshot bounded by watermarks.
 */
abstract snapshot(filter?: LedgerQuery): Promise<LedgerSnapshot>

/** Read committed body-free facts for a secondary storage mirror; unsupported providers return no facts.
 * @returns Retained facts and whether their history is complete.
 */
facts(): Promise<{ events: readonly LedgerEvent[]; complete: boolean }>

/** Price observed usage with decimal fixed-point arithmetic.
 * @param request - Frozen price, timestamp, tiers, and usage.
 * @returns Reference amount or explicit coverage gap.
 */
abstract priceUsage(request: LedgerPriceUsageRequest): LedgerPriceUsageResult

/** Resolve the persisted local node identity.
 * @returns Stable node identity after synchronization.
 */
abstract nodeId(): Promise<LedgerNodeId>

/** Import validated offline node facts.
 * @param source - Local source node directory.
 * @returns Per-fact append, replay, or conflict outcomes.
 */
abstract importNode(source: string): Promise<readonly LedgerAppendResult[]>

/** Open the independent message journal without changing call accounting.
 * @returns Body-free message fact storage using the ledger's local node identity.
 */
messages(): Promise<MessageLedgerStore>

/** Project all retained versions before selecting current message states.
 * @param query - Session, creation-time, state, class, age and pagination selection.
 * @returns Message statuses and integrity of the full scan.
 */
async queryMessages(query: MessageQuery): Promise<LedgerMessagePage>

/** Join both namespaces by Session without adding messages to billable call rows.
 * @param query - Shared Session and half-open time filter; all matching messages are retained.
 * @returns Independent journal views grouped by Session, not an atomic cross-journal snapshot.
 */
async querySessions(query: Pick<LedgerQuery, 'sessionId' | 'from' | 'to'>): Promise<LedgerSessionPage>

/** Export a selected message page without bodies, with an integrity header even when empty.
 * @param query - Message filters and optional page cursor.
 * @returns Schema-versioned JSONL metadata and status records.
 */
async exportMessages(query: MessageQuery): Promise<string>
```

Types: [CallContributor](persistence.md) · [MessageQuery](persistence.md)

Source: [`packages/session/session-ledger/src/index.ts`](../../packages/session/session-ledger/src/index.ts)

<a id="ctxsessiontelemetry--sessiontelemetrybackend-abstract-seam"></a>

### `ctx.sessionTelemetry` — `SessionTelemetryBackend` (abstract seam)

Loadable form of the backend contract: one implementation per context — the cordis `Service` registration under the `telemetry` key throws on a duplicate, cordis' standard behavior. A backend composes a SessionTelemetryCoordinator in its constructor to install the capture side.

```ts cordis-catalog
/**
 * See {@link SessionTelemetrySink.emit} — that declaration is the contract's one home.
 * @param record - the logical record to report; owned by the backend after the call.
 */
abstract emit(record: SessionTelemetryRecord): void

/** See {@link SessionTelemetrySink.flush}. */
flush?(): void

/**
 * See {@link SessionTelemetrySink.shutdown}.
 * @returns resolves when the backend's pipeline has quiesced.
 */
abstract shutdown(): Promise<void>
```

Source: [`packages/session/session-telemetry/src/index.ts`](../../packages/session/session-telemetry/src/index.ts)

<a id="ctxstats--statsservice"></a>

### `ctx.stats` — `StatsService`

No write, export, transcript, model, or caller-supplied identity capability is exposed.

```ts cordis-catalog
/** Describe storage and configuration without reading usage, including while disabled.
 * @returns Absolute profile and local journal paths, or null for an unknown provider.
 */
@Remote locations(): { configFile: string | null; configDirectory: string | null; dataDirectory: string | null }

/** Read one deduplicated ledger snapshot from the installed query provider.
 * @param request - Fixed time range, bucket, grouping and optional attribution filters.
 * @returns Coverage-aware projection plus the deployment's current refresh cadence.
 */
@Remote async read(request: StatsRequest): Promise<{ view: StatsView; refreshIntervalMs: number }>
```

Source: [`packages/client/ui-stats/src/index.ts`](../../packages/client/ui-stats/src/index.ts)

<a id="ledger-watch-events"></a>

### `ledger-watch/*` events

<a id="ledger-watchowner-settled--emit"></a>

#### `ledger-watch/owner-settled` — emit

A killed run has a durable terminal acknowledgement; consumers must fence by run identity.

```ts cordis-catalog
/**
 * A killed run has a durable terminal acknowledgement; consumers must fence by run identity.
 * @param payload - exact owner and acknowledged terminal evidence; repeat delivery is possible.
 * @mode emit
 */
'ledger-watch/owner-settled'(payload: LedgerOwnerSettled): void
```

Source: [`packages/session/ledger-watch/src/types.ts`](../../packages/session/ledger-watch/src/types.ts)

<a id="session-telemetry-events"></a>

### `session-telemetry/*` events

<a id="session-telemetryrecord--waterfall"></a>

#### `session-telemetry/record` — waterfall

Transform one outbound record before it reaches the backend. This waterfall is the Service Definition's redaction extension point. It ships NO rules of its own: the innermost `next()` passes the record through unchanged, and with no listener mounted records reach the backend as captured, so exported data is exactly as clean as the rules a deployment mounts. Listeners stack by transforming `next()`'s return value; returning without `next()` replaces everything beneath. Dispatched synchronously on the capture hot path inside the coordinator's containment: a throwing listener withholds that one record (fail-closed) and never reaches the agent loop. Live capture dispatches at append time; on-demand capture dispatches while reading the canonical log. Redaction applies to the exported copy only; the canonical session log is never rewritten.

```ts cordis-catalog
/**
 * Transform one outbound record before it reaches the backend. This
 * waterfall is the Service Definition's redaction extension point. It ships NO rules
 * of its own: the
 * innermost `next()` passes the record through unchanged, and with no
 * listener mounted records reach the backend as captured, so exported
 * data is exactly as clean as the rules a deployment mounts. Listeners
 * stack by transforming `next()`'s return value; returning without
 * `next()` replaces everything beneath. Dispatched synchronously on the
 * capture hot path inside the coordinator's containment: a throwing
 * listener withholds that one record (fail-closed) and never reaches the
 * agent loop. Live capture dispatches at append time; on-demand capture
 * dispatches while reading the canonical log. Redaction applies to the
 * exported copy only; the canonical session log is never rewritten.
 * @param record - the candidate record, already the coordinator's own deep
 *   copy; listeners return a (possibly new) record and must not mutate it.
 * @mode waterfall
 */
'session-telemetry/record'(record: SessionTelemetryRecord, next: () => SessionTelemetryRecord): SessionTelemetryRecord
```

Source: [`packages/session/session-telemetry/src/index.ts`](../../packages/session/session-telemetry/src/index.ts)
<!-- END GENERATED cordis-surface -->
