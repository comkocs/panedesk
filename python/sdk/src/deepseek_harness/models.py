from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Annotated, Callable, Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, Field, model_validator

JsonScalar: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonScalar | dict[str, "JsonValue"] | list["JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]


@dataclass(slots=True)
class Notification:
    method: str
    payload: JsonObject


@dataclass(slots=True)
class IncomingRequest:
    id: str | int
    method: str
    payload: JsonObject


class ServerInfo(BaseModel):
    name: str | None = None
    version: str | None = None


class InitializeExecutionPolicy(BaseModel):
    """Expected installed preset version and canonical policy digest, not tool authority."""

    presetId: str
    version: str
    digest: str


class InitializeLedgerContext(BaseModel):
    """Inherited attribution and parent/child linkage, outside the Session header."""

    seat: str
    window: str
    taskId: str | None = None
    nodeId: str
    identitySource: Literal["startup", "environment", "settings", "inherited", "free"]
    parentSessionId: str
    rootSessionId: str
    subagentRunId: str
    parentRunId: str
    childSessionId: str
    accountLabel: str | None = None
    deliveryPaths: list[str] | None = None


class LlmCacheControl(BaseModel):
    """Session retention and stable key; omitted fields retain runtime defaults."""

    retention: Literal["default", "none", "5m", "1h", "30m", "12h", "auto"]
    key: str | None = None


class InitializeResponse(BaseModel):
    serverInfo: ServerInfo | None = None
    messagesVersion: Annotated[int, Field(strict=True, gt=0, le=9007199254740991)] | None = None


MessagePriority: TypeAlias = Literal["immediate", "steer", "queue"]
MessageClass: TypeAlias = Literal["handoff", "notice", "reply"]
MessageState: TypeAlias = Literal["queued", "injected", "responded", "withdrawn", "invalidated", "rejected"]
MessageReason: TypeAlias = Literal[
    "target-closed-pending", "target-archived", "target-not-found", "target-ambiguous",
    "receive-disabled", "handoff-only", "cross-node-unsupported", "claimed", "injected",
    "revision-conflict", "operation-conflict", "unauthorized", "invalid-content",
    "invalid-priority", "invalid-reply", "message-not-found", "terminal-state",
    "unavailable", "delivery-uncertain", "unsupported", "interjection", "record-corrupt",
]
MessageTransition: TypeAlias = Literal[
    "accepted", "rejected", "claimed", "appended", "rolled-back", "injected",
    "responded", "withdrawn", "edited", "reprioritized", "invalidated", "delivery-uncertain",
]
_MessageText: TypeAlias = Annotated[str, Field(min_length=1)]
_MessageInteger: TypeAlias = Annotated[int, Field(ge=0, le=9007199254740991)]


class _MessageModel(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", allow_inf_nan=False, populate_by_name=True)


class MessageAddress(_MessageModel):
    """Exact Session identity or name; omitted node selects the local node."""

    nodeId: _MessageText | None = None
    sessionId: _MessageText | None = None
    name: _MessageText | None = None

    @model_validator(mode="after")
    def _exclusive_address(self) -> "MessageAddress":
        if (self.sessionId is None) == (self.name is None):
            raise ValueError("message address requires exactly one of sessionId or name")
        return self


class MessageRecipient(_MessageModel):
    """Resolved identity and runtime availability at observedAt."""

    nodeId: _MessageText
    sessionId: _MessageText
    window: _MessageText | None
    title: _MessageText | None
    status: Literal["busy", "idle", "closed"]
    matchedFields: list[Literal["sessionId", "window", "title"]]
    observedAt: float


class ResolvedMessageRecipient(_MessageModel):
    """Unique resolution without opening or delivering to a Session."""

    kind: Literal["resolved"]
    address: MessageAddress
    recipient: MessageRecipient


class RejectedMessageRecipient(_MessageModel):
    """Resolution refusal with explicit candidates, never an arbitrary selection."""

    kind: Literal["rejected"]
    address: MessageAddress
    reason: MessageReason
    candidates: list[MessageRecipient]


ResolvedRecipient: TypeAlias = Annotated[
    ResolvedMessageRecipient | RejectedMessageRecipient, Field(discriminator="kind")
]


class MessageSettings(_MessageModel):
    """Complete receive policy; replies qualify under handoff-only."""

    receiveMode: Literal["all", "handoff-only", "none"]
    wakeOnHandoff: bool


class _MessageClassification(_MessageModel):
    messageClass: MessageClass
    replyTo: _MessageText | None = None

    @model_validator(mode="after")
    def _reply_association(self) -> "_MessageClassification":
        if (self.messageClass == "reply") != (self.replyTo is not None):
            raise ValueError("replyTo is required only for reply messages")
        return self


class SendMessageRequest(_MessageClassification):
    """New sends default to steer; notices default to passive queue."""

    target: MessageAddress
    content: _MessageText
    priority: MessagePriority | None = None
    operationId: _MessageText


class MessageStateData(_MessageModel):
    """Runtime-owned receipt facts; model-authored text cannot advance state."""

    messageId: _MessageText
    senderSessionId: _MessageText | None
    targetSessionId: _MessageText | None
    priority: MessagePriority
    messageClass: MessageClass
    state: MessageState
    revision: _MessageInteger
    stateVersion: _MessageInteger
    operationId: _MessageText
    transition: MessageTransition
    observedAt: float
    reason: MessageReason | None = None
    firstRequestId: _MessageText | None = None
    firstTurnId: _MessageInteger | None = None
    deliveryOutcome: Literal["accepted", "rejected"] | None = None
    pending: bool | None = None


class MessageStateEvent(_MessageModel):
    """Durable receipt cursor, independent of Session event positions."""

    cursor: _MessageText
    nodeId: _MessageText
    data: MessageStateData


class MessageStatus(_MessageModel):
    """Status preserves first injection even when response attribution moves."""

    messageId: _MessageText
    state: MessageState
    phase: Literal["pending", "claimed", "appended", "dispatched", "settled", "delivery-uncertain"]
    revision: _MessageInteger
    stateVersion: _MessageInteger
    transitions: list[MessageStateEvent]


class SendMessageResult(_MessageModel):
    """Closed-target rejection may retain a queued pending message."""

    messageId: _MessageText
    operationId: _MessageText
    deliveryOutcome: Literal["accepted", "rejected"]
    messageState: Literal["queued", "rejected"]
    pending: bool
    recipient: MessageRecipient | None = None
    reason: MessageReason | None = None
    candidates: list[MessageRecipient] | None = None

    @model_validator(mode="after")
    def _delivery_outcome(self) -> "SendMessageResult":
        if self.deliveryOutcome == "accepted":
            valid = self.messageState == "queued" and self.recipient is not None
        elif self.reason == "target-closed-pending":
            valid = self.messageState == "queued" and self.pending and self.recipient is not None
        else:
            valid = (self.reason is not None and self.messageState == "rejected"
                     and not self.pending and self.candidates is not None)
        if not valid:
            raise ValueError("inconsistent message delivery outcome")
        return self


class MessageControlRequest(_MessageModel):
    """Durable control intent, arbitrated only by the target owner."""

    messageId: _MessageText
    operationId: _MessageText
    expectedRevision: _MessageInteger


class EditMessageRequest(MessageControlRequest):
    """Text replacement retaining the original message identity."""

    content: _MessageText


class ReprioritizeMessageRequest(MessageControlRequest):
    """Explicit priority change retaining the original message identity."""

    priority: MessagePriority


class InvalidateMessageRequest(MessageControlRequest):
    """Invalidation preserves injected history and queues a separate notice."""

    reason: _MessageText


class AppliedMessageControl(_MessageModel):
    """A control confirmed by the target owner."""

    kind: Literal["applied"]
    operationId: _MessageText
    messageId: _MessageText
    status: MessageStatus


class PendingMessageControl(_MessageModel):
    """Stored intent is not a successful withdrawal."""

    kind: Literal["accepted-pending-owner"]
    operationId: _MessageText
    messageId: _MessageText
    state: Literal["queued"]
    revision: _MessageInteger


class RejectedMessageControl(_MessageModel):
    """Refusal retains current status when it is available."""

    kind: Literal["rejected"]
    operationId: _MessageText
    messageId: _MessageText
    reason: MessageReason
    status: MessageStatus | None


ControlResult: TypeAlias = Annotated[
    AppliedMessageControl | PendingMessageControl | RejectedMessageControl,
    Field(discriminator="kind"),
]


class UnknownMessageOperation(_MessageModel):
    """An unknown operation is distinct from a pending control."""

    kind: Literal["not-found"]
    operationId: _MessageText


OperationStatus: TypeAlias = Annotated[
    AppliedMessageControl | PendingMessageControl | RejectedMessageControl | UnknownMessageOperation,
    Field(discriminator="kind"),
]


class MessageQuery(_MessageModel):
    """Half-open time filters and opaque receipt pagination; from_ encodes as from."""

    sessionId: _MessageText | None = None
    senderSessionId: _MessageText | None = None
    targetSessionId: _MessageText | None = None
    nodeId: _MessageText | None = None
    from_: float | None = Field(default=None, alias="from")
    to: float | None = None
    states: list[MessageState] | None = None
    messageClasses: list[MessageClass] | None = None
    unansweredOlderThanMinutes: Annotated[float, Field(ge=0)] | None = None
    includeTerminal: bool | None = None
    cursor: _MessageText | None = None
    limit: Annotated[int, Field(gt=0, le=9007199254740991)] | None = None


class MessagePage(_MessageModel):
    """An incomplete scan never masquerades as an empty complete result."""

    items: list[MessageStatus]
    complete: bool
    nextCursor: _MessageText | None = None


class MessageBatchRecipient(_MessageModel):
    """Explicit batch target with its own caller-retained operation identity."""

    target: MessageAddress
    operationId: _MessageText


class SendBatchRequest(_MessageClassification):
    """Dry runs resolve recipients without minting or delivering messages."""

    content: _MessageText
    priority: MessagePriority | None = None
    recipients: list[MessageBatchRecipient]
    dryRun: bool


class ResolvedMessageBatch(_MessageModel):
    """Read-only batch resolution results."""

    kind: Literal["resolved"]
    recipients: list[ResolvedRecipient]


class SentMessageBatch(_MessageModel):
    """Independent send outcomes; no whole-batch transaction is promised."""

    kind: Literal["sent"]
    results: list[SendMessageResult]


SendBatchResult: TypeAlias = Annotated[ResolvedMessageBatch | SentMessageBatch, Field(discriminator="kind")]


class ConfigureMessagesRequest(_MessageModel):
    """Complete policy replacement, not an implicit reset of omitted fields."""

    sessionId: _MessageText
    settings: MessageSettings


class MessageSubscriptionRequest(_MessageModel):
    """Replay strictly after cursor; omission includes currently retained receipts."""

    sessionId: _MessageText
    cursor: _MessageText | None = None


class MessagesSubscribeResult(_MessageModel):
    """Admission echoes the requested cursor, not a consumed receipt position."""

    cursor: _MessageText | None = None


class MessageStreamError(_MessageModel):
    """Storage failure for one Session receipt stream, without provider diagnostics."""

    sessionId: _MessageText
    reason: Literal["unavailable"]


_SeatCheck = Callable[[object], bool]
_SEAT_MISSING = object()


def _seat_text(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _seat_integer(value: object) -> bool:
    return type(value) is int and 0 <= value <= 9007199254740991


def _seat_number(value: object) -> bool:
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def _seat_choice(*values: str) -> _SeatCheck:
    return lambda value: isinstance(value, str) and value in values


def _seat_optional(check: _SeatCheck) -> _SeatCheck:
    return lambda value: value is _SEAT_MISSING or check(value)


def _seat_nullable(check: _SeatCheck) -> _SeatCheck:
    return lambda value: value is None or check(value)


def _seat_array(check: _SeatCheck) -> _SeatCheck:
    return lambda value: isinstance(value, list) and all(check(item) for item in value)


def _seat_record(check: _SeatCheck) -> _SeatCheck:
    return lambda value: isinstance(value, dict) and all(isinstance(key, str) and check(item) for key, item in value.items())


def _seat_fields(checks: dict[str, _SeatCheck]) -> _SeatCheck:
    return lambda value: isinstance(value, dict) and not (set(value) - set(checks)) and all(check(value.get(key, _SEAT_MISSING)) for key, check in checks.items())


def _seat_check_fields(value: object, checks: dict[str, _SeatCheck]) -> None:
    if not _seat_fields(checks)(value):
        raise ValueError("invalid seat fields")


def _seat_json(value: object) -> bool:
    return value is None or isinstance(value, (str, bool)) or (type(value) in (int, float) and math.isfinite(value)) or _seat_array(_seat_json)(value) or _seat_record(_seat_json)(value)


_SEAT_BOOL: _SeatCheck = lambda value: type(value) is bool
_SEAT_STRING: _SeatCheck = lambda value: isinstance(value, str)
_SEAT_MONEY: _SeatCheck = lambda value: isinstance(value, str) and value.isascii() and value.isdecimal() and (value == "0" or not value.startswith("0"))
_SEAT_BUDGET = _seat_fields({"windowBudgetUsd": _seat_optional(_SEAT_MONEY), "dailyBudgetUsd": _seat_optional(_SEAT_MONEY)})
_SEAT_DIRECTORY = _seat_fields({"path": _seat_text, "startup": _SEAT_BOOL})
_SEAT_TEXT: _SeatCheck = lambda value: _seat_fields({"kind": _seat_choice("text"), "text": _SEAT_STRING})(value) or _seat_fields({"kind": _seat_choice("file"), "path": _seat_text, "section": _seat_optional(_seat_text)})(value)
_SEAT_SCHEDULE = _seat_fields({"after_seconds": _seat_optional(_seat_integer), "every_seconds": _seat_optional(_seat_integer),
    "at": _seat_optional(lambda value: _seat_text(value) or _seat_fields({"date": _seat_text, "time": _seat_text, "time_zone": _seat_text})(value)),
    "daily": _seat_optional(_seat_fields({"time": _seat_text, "time_zone": _seat_text})),
    "weekly": _seat_optional(_seat_fields({"time": _seat_text, "time_zone": _seat_text, "weekdays": _seat_array(_seat_integer)})),
    "cron": _seat_optional(_seat_fields({"expression": _seat_text, "time_zone": _seat_text}))})
_SEAT_TRIGGER: _SeatCheck = lambda value: any(_seat_fields(fields)(value) for fields in (
    {"kind": _seat_choice("schedule"), "selector": _SEAT_SCHEDULE, "timeZone": _seat_text},
    {"kind": _seat_choice("git"), "repositoryId": _seat_text, "ref": _seat_text},
    {"kind": _seat_choice("external"), "sourceId": _seat_text, "eventType": _seat_optional(_seat_text)},
    {"kind": _seat_choice("window-ended"), "seat": _seat_text, "on": _seat_choice("closed", "can-close")},
    {"kind": _seat_choice("handoff-timeout"), "timeoutMinutes": _seat_integer},
    {"kind": _seat_choice("manual"), "origin": _seat_choice("manual", "remote")},
))
_SEAT_DEFINITION: dict[str, _SeatCheck] = {
    "schemaVersion": lambda value: type(value) is int and value == 1, "revision": _seat_integer, "seat": _seat_text,
    "platform": _seat_choice("desktop", "vscode", "server"), "node": _seat_text, "projectId": _seat_text,
    "directories": _seat_array(_SEAT_DIRECTORY), "memoryDirectories": _seat_array(_seat_text), "opening": _SEAT_TEXT,
    "openingInstructionFiles": _seat_array(_seat_text), "agentPreset": _seat_text, "provider": _seat_text, "model": _seat_text,
    "reasoningEffort": _seat_text, "permissionPreset": _seat_text, "subscriptions": _seat_array(_seat_text),
    "checkpointFiles": _seat_array(_seat_fields({"path": _seat_text, "section": _seat_text, "maxBytes": _seat_integer, "required": _SEAT_BOOL})),
    "wakeTemplate": _seat_optional(_SEAT_TEXT), "maxOpenSessions": _seat_integer, "maxActiveSubagents": _seat_integer,
    "contextThresholdTokens": _seat_optional(_seat_integer), "subagentContextThresholdTokens": _seat_integer,
    "pollingThreshold": _seat_optional(_seat_integer), "maxSleepSeconds": _seat_optional(_seat_integer), "autoKeepAlive": _seat_optional(_SEAT_BOOL),
    "worktree": _seat_fields({"clientTreesPerSlot": _seat_integer, "staleOnSettle": _seat_choice("notify"), "lightByDefault": _SEAT_BOOL, "staleHours": _seat_integer}),
    "rules": _seat_array(_seat_fields({"id": _seat_text, "enabled": _SEAT_BOOL, "trigger": _SEAT_TRIGGER, "mode": _seat_optional(_seat_choice("off", "remind", "auto")),
        "timeWindows": _seat_array(_seat_fields({"timeZone": _seat_text, "start": _seat_text, "end": _seat_text, "weekdays": _seat_optional(_seat_array(_seat_integer))})),
        "exclusiveTags": _seat_array(_seat_text), "modelAccountConcurrency": _seat_optional(_seat_array(_seat_fields({"accountLabel": _seat_text, "limit": _seat_integer}))),
        "timeoutMinutes": _seat_optional(_seat_integer), "windowBudgetUsd": _seat_optional(_SEAT_MONEY), "dailyBudgetUsd": _seat_optional(_SEAT_MONEY)})),
    "source": _seat_optional(_seat_fields({"sourcePath": _seat_text, "sourceFileHash": _seat_text, "rowHash": _seat_text, "mappingHash": _seat_text,
        "columnHashes": _seat_record(_seat_text), "baseline": _seat_record(_seat_json), "authority": _seat_choice("import-source", "seat-store")})),
}
_SEAT_WAIT_OBJECT = {"kind": _seat_choice("subagent", "job", "schedule", "message"), "id": _seat_text}
_SEAT_REPORT = {"reportId": _seat_text, "sessionId": _seat_text, "canClose": _SEAT_BOOL,
    "waitingFor": _seat_array(_seat_fields({"kind": _seat_choice("subagent", "job", "schedule", "message", "other"), "objectId": _seat_optional(_seat_text), "summary": _SEAT_STRING})),
    "nextOpen": _seat_fields({"when": lambda value: any(_seat_fields(fields)(value) for fields in (
        {"kind": _seat_choice("unspecified")}, {"kind": _seat_choice("at"), "at": _seat_text}, {"kind": _seat_choice("condition"), "description": _seat_text})), "prerequisites": _seat_array(_seat_text)}),
    "submittedAt": _seat_text, "stateVersion": _seat_integer}


_SEAT_CODES = frozenset("""seat-not-found seat-already-open seat-choice-required cross-node-unsupported import-preview-stale import-conflict
import-source-authoritative seat-store-authoritative invalid-definition invalid-request unsupported-schema-version revision-conflict
operation-id-conflict event-id-conflict unauthorized unavailable disabled engine-store-corrupt session-not-found session-busy state-conflict
owner-unknown memory-seat-mismatch wake-template-missing batch-explicit-seats-required batch-limit-exceeded cache-evidence-unavailable cache-expired
cache-prefix-changed maintenance-busy renewal-uncertain subagent-renewal-expired subagent-context-limit evidence-unavailable polling sleep-limit-exceeded
gate-denied audit-unavailable checkpoint-unavailable checkpoint-changed checkpoint-budget-exceeded budget-unverifiable budget-full budget-stopped
source-not-found source-authentication-failed source-payload-too-large source-timestamp-invalid callback-authentication-failed callback-protocol-error
open-create-failed open-configuration-failed opening-failed session-id-conflict replacement-open-failed replacement-first-turn-failed replacement-cleanup-failed
wait-id-conflict wait-object-not-found wait-object-unauthorized ticket-not-found ticket-cancelled report-not-found report-revoked causal-depth-exceeded
rule-self-loop query-cursor-invalid export-event-conflict worktree-client-limit worktree-unverified""".split())
_SEAT_FAILURE = _seat_fields({"code": _seat_choice(*_SEAT_CODES), "message": _seat_text, "alternative": _seat_text,
    "retryable": _SEAT_BOOL, "effectState": _seat_choice("none", "committed", "partial", "unknown")})
_SEAT_IMPORT_ROW = _seat_fields({"row": _seat_integer, "seat": _seat_nullable(_seat_text), "definition": _seat_nullable(_seat_fields(_SEAT_DEFINITION)),
    "rowHash": _seat_text, "columnHashes": _seat_record(_seat_text), "action": _seat_choice("create", "update", "retain", "conflict", "tombstone", "invalid"),
    "selected": _SEAT_BOOL, "differences": _seat_array(_seat_fields({"field": _seat_text, "baseline": _seat_json, "local": _seat_json, "source": _seat_json, "conflict": _SEAT_BOOL})),
    "diagnostics": _seat_array(_SEAT_FAILURE)})
_SEAT_WAIT = _seat_fields({"waitId": _seat_text, "sessionId": _seat_text, "mode": _seat_choice("any", "all"), "objects": _seat_array(_seat_fields(_SEAT_WAIT_OBJECT)),
    "observations": _seat_array(_seat_fields({"object": _seat_fields(_SEAT_WAIT_OBJECT), "outcome": _seat_choice("completed", "failed", "cancelled", "owner-lost", "unknown"),
        "observedAt": _seat_text, "watermark": _seat_integer, "durability": _seat_choice("durable", "best-effort")})),
    "phase": _seat_choice("registered", "satisfied", "woken", "cancelled"), "operationId": _seat_text, "wakeOperationId": _seat_text,
    "toolCallId": _seat_optional(_seat_text), "rootCallId": _seat_optional(_seat_text), "stateVersion": _seat_integer, "durability": _seat_choice("durable", "best-effort")})
_SEAT_BINDING: _SeatCheck = lambda value: _seat_fields({"kind": _seat_choice("free"), "sessionId": _seat_text, "nodeId": _seat_text, "identitySource": _seat_choice("free")})(value) or _seat_fields({
    "kind": _seat_choice("seat"), "sessionId": _seat_text, "seat": _seat_text, "projectId": _seat_text, "nodeId": _seat_text, "bindingSource": _seat_choice("seat-definition"),
    "identitySource": _seat_choice("settings", "inherited"), "openOperationId": _seat_text, "seatRevision": _seat_integer, "taskId": _seat_optional(_seat_text),
    "relatedTaskIds": _seat_array(_seat_text), "directories": _seat_array(_SEAT_DIRECTORY), "memoryDirectories": _seat_array(_seat_text),
    "subscriptions": _seat_array(_seat_text), "openingDigest": _seat_text})(value)
_SEAT_CANDIDATE = {"seat": _seat_text, "sessionId": _seat_text, "title": _SEAT_STRING, "nodeId": _seat_text}
_SEAT_BUSY = _seat_fields({"kind": _seat_choice("turn", "subagent", "job", "approval", "plan-review", "answer", "wait", "ticket", "inbox", "owner-unknown"),
    "objectId": _seat_optional(_seat_text), "summary": _SEAT_STRING})
_SEAT_WINDOW = _seat_fields({**_SEAT_CANDIDATE, "status": _seat_nullable(_seat_choice("running", "idle", "approval-pending", "plan-review-pending", "answer-pending", "completed")),
    "engineStatus": _seat_choice("active", "prefilled", "budget-stopped", "configuring", "closing", "unknown"), "evidence": _seat_choice("complete", "unknown"),
    "idleMinutes": _seat_nullable(_seat_number), "runningSubagents": _seat_integer, "activeJobs": _seat_integer, "canRenew": _SEAT_BOOL,
    "renewRejection": _seat_nullable(_SEAT_FAILURE), "busyReasons": _seat_array(_SEAT_BUSY), "stateVersion": _seat_integer, "seatBinding": _seat_nullable(_SEAT_BINDING)})
_SEAT_CACHE = _seat_fields({"lastActivityAt": _seat_nullable(_seat_text), "cacheTtlMs": _seat_nullable(_seat_number), "prefixDigest": _seat_nullable(_seat_text),
    "observedAt": _seat_text, "reusableRequest": _SEAT_BOOL})
_SEAT_OPEN_PHASE = _seat_choice("intent", "creating", "created", "configuring", "opening-pending", "active", "opening-failed")
_SEAT_REPLACE_PHASE = _seat_choice("opening", "created", "configuring", "first-turn-pending", "awaiting-old-idle", "closing-old", "completed", "closing-new")
_SEAT_PERMIT = _seat_fields({"permitId": _seat_text, "replacementId": _seat_text, "oldSessionId": _seat_text, "newSessionId": _seat_text,
    "state": _seat_choice("issued", "first-turn-running", "expired-success", "expired-failure"), "issuedAt": _seat_text, "expiredAt": _seat_nullable(_seat_text), "ownerEpoch": _seat_text})
_SEAT_REASON = _seat_choice("approval", "project-off", "time-window", "node-capacity", "seat-capacity", "exclusive-tag", "budget-full", "budget-unverifiable", "provider-unavailable")
_SEAT_HANDOFF = {"messageId": _seat_text, "senderSessionId": _seat_text, "deadlineVersion": _seat_integer, "deadlineAt": _seat_text, "timeoutMinutes": _seat_number, "wakeOperationId": _seat_text}
_SEAT_EVIDENCE: _SeatCheck = lambda value: any(_seat_fields(fields)(value) for fields in (
    {"kind": _seat_choice("schedule"), "scheduleId": _seat_text, "scheduledAt": _seat_text},
    {"kind": _seat_choice("git"), "repositoryId": _seat_text, "ref": _seat_text, "oldObjectId": _seat_nullable(_seat_text), "newObjectId": _seat_nullable(_seat_text), "observationSequence": _seat_integer},
    {"kind": _seat_choice("external"), "eventType": _seat_text},
    {"kind": _seat_choice("window-ended"), "sessionId": _seat_text, "endedEventId": _seat_text, "reportId": _seat_nullable(_seat_text), "origin": _seat_choice("closed", "can-close")},
    {"kind": _seat_choice("handoff-timeout"), **_SEAT_HANDOFF}, {"kind": _seat_choice("manual"), "origin": _seat_choice("manual", "remote"), "operationId": _seat_text},
))
_SEAT_TRIGGER_KIND = _seat_choice("schedule", "git", "external", "window-ended", "handoff-timeout", "manual")
_SEAT_ENVELOPE = _seat_fields({"triggerId": _seat_text, "sourceId": _seat_text, "eventId": _seat_optional(_seat_text), "kind": _SEAT_TRIGGER_KIND, "evidence": _SEAT_EVIDENCE,
    "seat": _seat_text, "projectId": _seat_text, "receivedAt": _seat_text, "dataDigest": _seat_text, "data": _seat_json, "taskId": _seat_optional(_seat_text), "callbackRef": _seat_text,
    "cause": _seat_optional(_seat_fields({"eventId": _seat_text, "depth": _seat_integer}))})
_SEAT_PENDING = _seat_fields({"queueItemId": _seat_text, "seat": _seat_text, "projectId": _seat_text, "triggerKind": _SEAT_TRIGGER_KIND,
    "action": _seat_choice("open", "wake-sender", "replace"), "handoffTimeout": _seat_optional(_seat_fields(_SEAT_HANDOFF)), "sequence": _seat_integer,
    "effectiveMode": _seat_choice("off", "remind", "auto"), "reason": _SEAT_REASON, "blockedBy": _seat_array(_seat_text), "sources": _seat_array(_SEAT_ENVELOPE),
    "relatedTaskIds": _seat_array(_seat_text), "queuedAt": _seat_text, "stateVersion": _seat_integer})
_SEAT_HOOK = _seat_choice("before-open", "before-batch-open", "before-memory-write", "before-tool-call", "before-subagent-dispatch", "after-subagent-return", "after-compaction")
_SEAT_GATE = _seat_fields({"definition": _seat_fields({"id": _seat_text, "name": _seat_text, "hook": _SEAT_HOOK,
    "criterion": _seat_fields({"type": _seat_text, "parameters": _seat_record(_seat_json)}), "alternative": _seat_text, "expiresAt": _seat_nullable(_seat_text),
    "enabled": _SEAT_BOOL, "revision": _seat_integer, "order": lambda value: type(value) is int and abs(value) <= 9007199254740991}),
    "hitCount": _seat_integer, "expired": _SEAT_BOOL, "lastHitAt": _seat_nullable(_seat_text), "watermark": _seat_integer})


def validate_seat_result(method: str, value: object) -> None:
    """Validate complete wire evidence before returning it to an SDK caller."""
    if method == "binding" and value is None:
        return
    if not isinstance(value, dict):
        raise ValueError("invalid seat result")
    status = value.get("status")
    checks: dict[str, _SeatCheck]
    if status == "rejected":
        if method in ("operation", "nodeStatus", "pending", "gates"):
            raise ValueError("unexpected rejection")
        checks = {"status": _seat_choice("rejected"), "error": _SEAT_FAILURE}
        if method == "renew":
            checks["cacheEvidence"] = _SEAT_CACHE
    elif method == "import.preview":
        checks = {"planId": _seat_text, "sourceFileHash": _seat_text, "mappingHash": _seat_text, "baseRevision": _seat_integer, "rows": _seat_array(_SEAT_IMPORT_ROW)}
    elif method == "import.commit":
        checks = {"status": _seat_choice("committed"), "revision": _seat_integer, "rows": _seat_array(_SEAT_IMPORT_ROW)}
    elif method == "setAuthority":
        checks = {"status": _seat_choice("saved"), "revision": _seat_integer}
    elif method == "report.submit":
        checks = {"status": _seat_choice("recorded", "revoked"), "reportId": _seat_text, "stateVersion": _seat_integer}
    elif method in ("wait.register", "wait.cancel"):
        checks = {"status": _seat_choice("registered") if method == "wait.register" else _seat_choice("cancelled", "already-settled"), "wait": _SEAT_WAIT}
    elif method == "binding":
        if not _SEAT_BINDING(value):
            raise ValueError("invalid binding")
        return
    elif method == "list":
        checks = {"status": _seat_choice("listed"), "sessions": _seat_array(_SEAT_WINDOW), "unopenedSeats": _seat_array(_seat_text),
            "snapshotAt": _seat_text, "complete": _SEAT_BOOL, "nextCursor": _seat_optional(_seat_text)}
    elif method == "open" and status in ("opened", "prefilled"):
        checks = {"status": _seat_choice("opened", "prefilled"), **_SEAT_CANDIDATE, "nodeName": _seat_text, "budget": _SEAT_BUDGET,
            "phase": _SEAT_OPEN_PHASE, "stateVersion": _seat_integer, "callbackIds": _seat_array(_seat_text)}
        if status == "prefilled":
            checks["draft"] = _SEAT_STRING
    elif method == "open" and status == "cancelled":
        checks = {"status": _seat_choice("cancelled")}
    elif method == "open" and status == "switched":
        checks = {"status": _seat_choice("switched"), "window": _seat_fields(_SEAT_CANDIDATE)}
    elif method in ("open", "wake") and status == "choice-required":
        checks = {"status": _seat_choice("choice-required"), "candidates": _seat_array(_seat_fields(_SEAT_CANDIDATE))}
        if method == "open":
            checks.update(choices=lambda item: item == ["switch", "replace", "cancel"], defaultChoice=_seat_choice("switch"))
    elif method in ("open", "replace") and status == "queued":
        checks = {"status": _seat_choice("queued"), "queueItemId": _seat_text, "sequence": _seat_integer, "reason": _SEAT_REASON}
        if method == "open":
            checks["blockedBy"] = _seat_array(_seat_text)
        else:
            checks.update(replacementId=_seat_text, oldSessionId=_seat_text, phase=_seat_choice("queued"))
    elif method == "openBatch":
        checks = {"status": _seat_choice("processed"), "results": _seat_array(_seat_fields({"seat": _seat_text, "result": lambda item: _seat_result_matches("open", item)}))}
    elif method == "renew":
        checks = {"status": _seat_choice("renewed", "uncertain"), "cacheEvidence": _SEAT_CACHE}
        checks["sessionId" if status == "renewed" else "error"] = _seat_text if status == "renewed" else _SEAT_FAILURE
    elif method == "close":
        checks = {"status": _seat_choice("closed", "busy", "conflict")}
        if status == "closed":
            checks.update(sessionId=_seat_text, phase=_seat_choice("closed"), endedAt=_seat_text, stateVersion=_seat_integer)
        elif status == "busy":
            checks.update(sessionId=_seat_text, busyReasons=_seat_array(_SEAT_BUSY))
        else:
            checks.update(expectedStateVersion=_seat_integer, actualStateVersion=_seat_integer)
    elif method == "replace":
        checks = {"status": _seat_choice("replacing", "failed"), "replacementId": _seat_text, "oldSessionId": _seat_text}
        if status == "replacing":
            checks.update(newSessionId=_seat_text, phase=_SEAT_REPLACE_PHASE, permit=_SEAT_PERMIT)
        else:
            checks.update(newSessionId=_seat_nullable(_seat_text), phase=_seat_choice("failed"), reason=_seat_choice("replacement-open-failed", "replacement-first-turn-failed", "replacement-cleanup-failed"), cause=_SEAT_FAILURE, cleanup=_seat_choice("not-created", "closed", "pending"))
    elif method == "rename":
        source: _SeatCheck = lambda item: _seat_fields({"kind": _seat_choice("fallback", "user")})(item) or _seat_fields({"kind": _seat_choice("provider"), "provider": _seat_text,
            "model": _seat_optional(_seat_fields({"provider": _seat_text, "model": _seat_text}))})(item)
        checks = {"status": _seat_choice("renamed"), "sessionId": _seat_text, "title": _seat_fields({"title": _seat_text, "messageSeqs": _seat_array(_seat_integer), "source": source, "eventSeq": _seat_integer, "updatedAt": _seat_number})}
    elif method == "wake":
        checks = {"status": _seat_choice("opened", "sent", "stored-budget-stopped")}
        if status == "opened":
            checks["result"] = lambda item: _seat_result_matches("open", item)
        else:
            checks.update(sessionId=_seat_text, messageId=_seat_text, operationId=_seat_text)
    elif method == "setProjectMode":
        checks = {"status": _seat_choice("saved"), "policy": _seat_fields({"projectId": _seat_text, "mode": _seat_choice("off", "remind", "auto"), "modeChosen": _SEAT_BOOL, "revision": _seat_integer})}
    elif method in ("approve", "cancel"):
        checks = {"status": _seat_choice("approved" if method == "approve" else "cancelled"), "queueItemId": _seat_text, "stateVersion": _seat_integer}
    elif method == "nodeStatus":
        checks = {"nodeId": _seat_text, "nodeName": _seat_text, "engine": _seat_choice("running", "recovering", "unavailable"),
            "openEngineWindows": _seat_integer, "limit": _seat_nullable(_seat_integer), "readyAt": _seat_nullable(_seat_text)}
    elif method in ("pending", "gates"):
        checks = {"items" if method == "pending" else "gates": _seat_array(_SEAT_PENDING if method == "pending" else _SEAT_GATE),
            "complete": _SEAT_BOOL, "watermark": _seat_integer, "nextCursor": _seat_optional(_seat_fields({"nodeId": _seat_text, "sequence": _seat_integer, "effectIndex": _seat_integer}))}
    elif method == "operation":
        checks = {"status": _seat_choice("missing", "pending", "settled")}
        if status == "pending":
            checks.update(phase=_seat_choice("intent", "creating", "created", "configuring", "opening-pending", "active", "opening-failed", "admission", "rechecking", "archiving", "renaming", "flushing", "closed", "queued", "opening", "first-turn-pending", "awaiting-old-idle", "closing-old", "completed", "closing-new", "failed"), stateVersion=_seat_integer)
        elif status == "settled":
            checks["result"] = lambda item: any(_seat_result_matches(operation, item) for operation in ("open", "close", "replace", "wake", "renew", "rename"))
    else:
        raise ValueError("unknown seat method")
    if status != "rejected" and method in ("import.preview", "import.commit", "setAuthority", "report.submit", "wait.register", "wait.cancel") and not set(value).issubset(checks):
        raise ValueError("unexpected result field")
    if not all(check(value.get(key, _SEAT_MISSING)) for key, check in checks.items()):
        raise ValueError("invalid seat result evidence")


def _seat_result_matches(method: str, value: object) -> bool:
    try:
        validate_seat_result(method, value)
        return True
    except ValueError:
        return False


class SeatBindingRequest(BaseModel):
    """Local Session lookup without operation or authority fields."""

    model_config = ConfigDict(strict=True, extra="forbid")
    sessionId: _MessageText
    nodeId: _MessageText | None = None


class PreviewSeatImportRequest(BaseModel):
    """Preview explicit source columns without changing catalog authority."""

    model_config = ConfigDict(strict=True, extra="forbid")
    format: Literal["markdown", "csv"]
    sourcePath: _MessageText
    columnMap: dict[str, _MessageText]
    defaults: dict[str, object]
    table: _MessageText | None = None

    @model_validator(mode="after")
    def _defaults(self) -> "PreviewSeatImportRequest":
        _seat_check_fields(self.defaults, {key: _seat_optional(check) for key, check in _SEAT_DEFINITION.items()})
        return self


class CommitSeatImportRequest(BaseModel):
    """Commit only selected rows at the preview revision."""

    model_config = ConfigDict(strict=True, extra="forbid")
    planId: _MessageText
    selectedRows: list[_MessageInteger]
    expectedRevision: _MessageInteger
    operationId: _MessageText


class SetSeatAuthorityRequest(BaseModel):
    """Independent authorization is required for editing takeover."""

    model_config = ConfigDict(strict=True, extra="forbid")
    expectedRevision: _MessageInteger
    authority: Literal["import-source", "seat-store"]
    authorizationRef: _MessageText
    operationId: _MessageText


class SubmitCloseReportRequest(BaseModel):
    """Three report fields remain distinct from runtime eligibility."""

    model_config = ConfigDict(strict=True, extra="forbid")
    report: dict[str, object]
    operationId: _MessageText
    toolCallId: _MessageText | None = None
    rootCallId: _MessageText | None = None

    @model_validator(mode="after")
    def _report(self) -> "SubmitCloseReportRequest":
        _seat_check_fields(self.report, _SEAT_REPORT)
        return self


class RegisterSeatWaitRequest(BaseModel):
    """Observation registration does not await task completion."""

    model_config = ConfigDict(strict=True, extra="forbid")
    waitId: _MessageText
    sessionId: _MessageText
    mode: Literal["any", "all"]
    objects: list[dict[str, str]]
    operationId: _MessageText
    toolCallId: _MessageText | None = None
    rootCallId: _MessageText | None = None

    @model_validator(mode="after")
    def _objects(self) -> "RegisterSeatWaitRequest":
        for value in self.objects:
            _seat_check_fields(value, _SEAT_WAIT_OBJECT)
        return self


class CancelSeatWaitRequest(BaseModel):
    """Cancellation affects only observation, not the underlying tasks."""

    model_config = ConfigDict(strict=True, extra="forbid")
    waitId: _MessageText
    sessionId: _MessageText
    expectedStateVersion: _MessageInteger
    operationId: _MessageText


class SeatRequest(BaseModel):
    """Seat requests use the same camelCase fields as the TypeScript wire API."""

    model_config = ConfigDict(strict=True, extra="forbid", allow_inf_nan=False)
    nodeId: _MessageText | None = None


class SeatOperationRequest(SeatRequest):
    operationId: _MessageText


def _seat_explicit(value: str) -> str:
    if not value.strip() or value.lower() in ("all", chr(0x5168) + chr(0x90E8)) or any(c in "*?" or ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("explicit seat required")
    return value


class OpenSeatRequest(SeatOperationRequest):
    seat: _MessageText
    taskId: _MessageText | None = None
    expectedSeatRevision: _MessageInteger | None = None
    existingChoice: dict[str, str] | None = None

    @model_validator(mode="after")
    def _explicit_choice(self) -> "OpenSeatRequest":
        _seat_explicit(self.seat)
        if self.existingChoice is not None:
            kind = self.existingChoice.get("kind")
            required = {"kind"} if kind == "cancel" else {"kind", "sessionId"}
            if kind not in ("cancel", "switch", "replace") or set(self.existingChoice) != required:
                raise ValueError("invalid existing choice")
            if any(not value.strip() for value in self.existingChoice.values()):
                raise ValueError("empty existing choice")
        return self


class OpenSeatBatchRequest(SeatOperationRequest):
    seats: list[_MessageText]

    @model_validator(mode="after")
    def _explicit_seats(self) -> "OpenSeatBatchRequest":
        if not self.seats or len(set(self.seats)) != len(self.seats):
            raise ValueError("batch requires unique explicit seats")
        for seat in self.seats:
            _seat_explicit(seat)
        return self


class SeatSessionRequest(SeatOperationRequest):
    sessionId: _MessageText


class CloseSeatRequest(SeatSessionRequest):
    expectedStateVersion: _MessageInteger


class RenameSeatRequest(SeatSessionRequest):
    title: _MessageText


class WakeSeatRequest(SeatOperationRequest):
    seat: _MessageText
    sessionId: _MessageText | None = None

    @model_validator(mode="after")
    def _explicit_seat(self) -> "WakeSeatRequest":
        _seat_explicit(self.seat)
        return self


class ListSeatsRequest(SeatRequest):
    projectId: _MessageText | None = None
    cursor: _MessageText | None = None


class SeatFailure(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    code: _MessageText
    message: _MessageText
    alternative: _MessageText
    retryable: bool
    effectState: Literal["none", "committed", "partial", "unknown"]


class SeatResult(BaseModel):
    """Preserve additive provider evidence and reject unknown outcome tags."""

    model_config = ConfigDict(strict=True, extra="allow", allow_inf_nan=False)
    status: Literal["opened", "prefilled", "choice-required", "switched", "cancelled", "queued", "rejected",
                    "processed", "listed", "renewed", "uncertain", "closed", "busy", "conflict", "replacing",
                    "failed", "renamed", "sent", "stored-budget-stopped", "saved", "approved", "missing", "pending", "settled"]
    error: SeatFailure | None = None

    @model_validator(mode="after")
    def _rejected_evidence(self) -> "SeatResult":
        if self.status in ("rejected", "uncertain") and self.error is None:
            raise ValueError("failure requires evidence")
        data = self.model_extra or {}
        required = {
            "queued": ("queueItemId", "sequence", "reason"),
            "prefilled": ("sessionId", "seat", "nodeId", "nodeName", "title", "budget", "phase", "stateVersion", "callbackIds", "draft"),
            "processed": ("results",), "listed": ("sessions", "unopenedSeats", "snapshotAt", "complete"),
            "renewed": ("sessionId", "cacheEvidence"), "uncertain": ("cacheEvidence",),
            "closed": ("sessionId", "phase", "endedAt", "stateVersion"), "busy": ("sessionId", "busyReasons"),
            "conflict": ("expectedStateVersion", "actualStateVersion"),
            "replacing": ("replacementId", "oldSessionId", "newSessionId", "phase", "permit"),
            "failed": ("replacementId", "oldSessionId", "newSessionId", "phase", "reason", "cause", "cleanup"),
            "renamed": ("sessionId", "title"), "sent": ("sessionId", "messageId", "operationId"),
            "stored-budget-stopped": ("sessionId", "messageId", "operationId"),
            "choice-required": ("candidates",), "switched": ("window",),
            "pending": ("phase", "stateVersion"), "settled": ("result",),
        }.get(self.status, ())
        if self.status == "opened":
            required = ("result",) if "result" in data else ("sessionId", "seat", "nodeId", "nodeName", "title", "budget", "phase", "stateVersion", "callbackIds")
        if any(key not in data for key in required):
            raise ValueError("missing seat outcome evidence")
        if self.status == "queued":
            if not isinstance(data["queueItemId"], str) or not data["queueItemId"].strip() or type(data["sequence"]) is not int or data["sequence"] < 0:
                raise ValueError("invalid queued evidence")
        if self.status == "processed":
            if not isinstance(data["results"], list):
                raise ValueError("invalid batch evidence")
            for entry in data["results"]:
                if not isinstance(entry, dict) or not isinstance(entry.get("seat"), str):
                    raise ValueError("invalid batch entry")
                SeatResult.model_validate(entry.get("result"))
        if self.status == "opened" and "result" in data:
            SeatResult.model_validate(data["result"])
        return self


class SeatCursor(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    nodeId: _MessageText
    sequence: _MessageInteger
    effectIndex: _MessageInteger


class PendingSeatsRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    limit: Annotated[int, Field(gt=0, le=9007199254740991)]
    seat: _MessageText | None = None
    projectId: _MessageText | None = None
    cursor: SeatCursor | None = None

    @model_validator(mode="after")
    def _explicit_seat(self) -> "PendingSeatsRequest":
        if self.seat is not None:
            _seat_explicit(self.seat)
        return self


class SeatGatesRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    limit: Annotated[int, Field(gt=0, le=9007199254740991)]
    gateId: _MessageText | None = None
    hook: Literal["before-open", "before-batch-open", "before-memory-write", "before-tool-call", "before-subagent-dispatch", "after-subagent-return", "after-compaction"] | None = None
    cursor: SeatCursor | None = None


class SetSeatProjectModeRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    projectId: _MessageText
    mode: Literal["off", "remind", "auto"]
    expectedRevision: _MessageInteger
    operationId: _MessageText


class PendingSeatMutationRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    queueItemId: _MessageText
    expectedStateVersion: _MessageInteger
    operationId: _MessageText
