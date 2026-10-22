# 遥测（telemetry）

[English](session-telemetry.md) | 中文

[捕获服务](../../packages/session/session-telemetry/README.zh.md) 负责规范事件捕获、脱敏和交接游标。[反馈后端](../../packages/session/session-telemetry-otel/README.zh.md) 授权 Session 前缀，并负责独立队列、逐请求调度及 4,000,000 字节上限。上报数据不会进入模型请求。

源码：[`packages/session/session-telemetry/src/index.ts`](../../packages/session/session-telemetry/src/index.ts)

## 逻辑记录

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

每条权威[会话事件](session.zh.md)都会完整透传为一条有序 ledger 记录，包括每个携带完整紧凑 stream 的 `assistant/message` 或 `assistant/attempt`，以及该 seam 从未听说过、由插件合并进来的类型。进程本地 `agent/assistant-stream` frame 不进入该持久 feed。新 fork 从子会话自有后缀开始，包括继承标记和 fork 结束事件；恢复的 Session 从已存储前缀之后开始，包括恢复的 fork。后端可以选择 `includeHistory` 来包含完整前缀；重新收养同一对象时会从 handoff 游标之后继续。投递是尽力而为的：游标标记的是「已交接」而非「已送达」，记录可能丢失（崩溃、重载窗口）也可能重复（新对象回放、SDK 重试），因此接收端对 ledger 记录基于 `(session.id, session.format_version, event.seq)` 去重；ops 记录刻意省略这类标识——它们是用于告警的信号，而非用于累加的条目，重复被容忍而非被去重。

## 共享披露

每个后端都通过 `ctx.sessionTelemetry` 上必需的抽象 `sharing` 成员暴露其部署级模式（[Service Definition README](../../packages/session/session-telemetry/README.zh.md#the-sharing-disclosure)）。它既不是逐 Session 的接纳决定，也不是投递回执。`/feedback` 确认文本不查询它。

```ts type-equiv
/**
 * Deployment-selected session-sharing mode, not confirmation of SDK delivery.
 */
type SessionTelemetrySharingStatus = 'full' | 'feedback-only' | 'disabled'
```

## 捕获策略

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

`includeHistory` 允许捕获存储与继承的记录，但本身不授权捕获。[OTel 后端](../../packages/session/session-telemetry-otel/README.zh.md)使用按需捕获，并要求新的自身显式反馈；它只释放截至该反馈的完整前缀，适用于所有提供方。

## 后端约定

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

`SessionTelemetryBackend`（`ctx.sessionTelemetry`，[签名](#ctxsessiontelemetry--sessiontelemetrybackend-abstract-seam)）是该约定的可加载形态：每个上下文只允许一个实现，重复加载会抛出异常；后端在其构造函数中组合 seam 的 `SessionTelemetryCoordinator`，以此装配捕获侧。

## 脱敏 waterfall：`session-telemetry/record`

每条记录在权威事件副本与 `emit()` 之间都要经过 `session-telemetry/record` [waterfall](../cordis-primer.zh.md#cordis-waterfall-semantics)（[事件条目](#session-telemetryrecord--waterfall)）。seam 自身不带任何规则：未挂载监听器时，记录以捕获时的原样到达后端；导出数据能干净到什么程度，恰恰取决于部署方挂载了什么规则。监听器通过变换 `next()` 的返回值来堆叠；不调用 `next()` 就返回，即替换其下方的全部逻辑；抛出异常的监听器会在协调器的隔离范围内以 fail-closed 方式扣下这一条记录。脱敏只作用于导出副本；权威会话日志永不改写。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxledgerquery--ledgerqueryservice"></a>

### `ctx.ledgerQuery` — `LedgerQueryService`

Query providers read ledger snapshots without launching an Agent or model provider.

```ts cordis-catalog
/** Select and group unique call projections.
 * @param options - half-open time, attribution, and grouping selection.
 * @returns source snapshot and coverage-aware grouped totals.
 */
async query(options: LedgerQueryOptions): Promise<LedgerQueryResult>

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

Types: [MessageQuery](persistence.zh.md)

Source: [`packages/session/session-ledger/src/types.ts`](../../packages/session/session-ledger/src/types.ts)

<a id="ctxsessionledger--sessionledger-abstract-seam"></a>

### `ctx.sessionLedger` — `SessionLedger` (abstract seam)

Durable ledger contract; implementations alone own storage and runtime hooks.

```ts cordis-catalog
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

Types: [MessageQuery](persistence.zh.md)

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
