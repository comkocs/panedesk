# Seat orchestration

English | [中文](seat.zh.md)

This page owns the types and service semantics declared by the [seat package group](../../packages/seat/README.md). Providers and consumers remain optional; the [application bundle](../../packages/seat/seat-app/README.md) owns explicit composition.

## Identity and authority

`SeatName` identifies a node-local definition; `SeatOperationId` identifies a caller-retained operation. Session identity remains the upstream `SessionId`. `SeatCallContext` contains authenticated principal, origin, and node identity supplied by a trusted adapter, not accepted as request authority. `SeatBinding` is engine metadata beside the Session log, with distinct free and seat variants.

## Definitions and admission

`SeatDefinition` freezes its revision, startup and additional directories, opening text, model and permission selections, subscriptions, checkpoint files, rules, and local capacity. Import previews retain source and mapping digests; committing selected rows checks both the original source and catalog revision. Source authority changes only through an authorized operation.

`SeatProjectPolicy` defaults to reminder mode until explicitly selected. Rules cannot widen project policy. `SeatQueued` reports FIFO identity and blocking reasons without claiming resources. `ChildAdmissionTicket` represents nonblocking child admission; cancelling an unstarted ticket does not terminate a running child. `SeatTurnAdmission` defers only a new turn and leaves queued input intact.

## Window operations

`OpenSeatResult` distinguishes opened, prefilled, existing-window choices, switched, cancelled, queued, and rejected outcomes. Creation does not imply first-turn completion. `ReplaceSeatResult` preserves old and new identities and cleanup state; replacement opens new before closing old and retains an explicit handover permit. `CloseSeatResult` distinguishes closed, busy, version conflict, and refusal. Unknown activity is not idle evidence.

`SeatWindowView` projects runtime state, busy reasons, cache evidence, and state version. `SeatContextUsage` represents dated current-context evidence, not accumulated accounting tokens. Missing evidence remains unknown. `SeatFailure` carries a machine code, explanation, alternative, retryability, and observed effect state.

## Engine records and queries

`EngineDecision` commits one bounded frame containing typed `EngineEffect` records under writer ownership and expected-sequence comparison. The engine journal is separate from Session, accounting, and message journals. Callbacks use stable identities and at-least-once outbox delivery; recovery does not replay uncertain model effects.

`EngineCursor` advances exclusively by node, sequence, and effect index. Query time ranges are half-open; results expose completeness and a committed watermark. Export is redacted unless independently authorized. Verification never executes imported operations. `SeatBudgetSnapshot` preserves unknown cost instead of treating it as zero; `MicroUsd` uses decimal integer micro-USD.

## Waits, reports, and policies

`SeatWait` registers any/all observations of explicit subagent, job, schedule, or message objects, returning before completion. Cancellation affects observation only. `CloseSelfReport` records close intent, outstanding work, and next-open prerequisites without changing runtime status.

`GateDefinition` selects an installed criterion, hook, revision, ordering, and expiration. `GateContext` contains executor-owned facts; `GateResult` preserves allow, deny, or not-applicable outcomes and audit state. `SeatWorktreeHost` owns revision-checked persistence and force authorization; `SeatReminderHost` owns child threshold delivery. Neither an operation string nor model text supplies authorization.

## Cordis API

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->
<!-- END GENERATED cordis-surface -->
