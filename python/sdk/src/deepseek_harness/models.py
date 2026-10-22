from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Literal, TypeAlias

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
