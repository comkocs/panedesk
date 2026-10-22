from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, TypeAlias

from pydantic import BaseModel

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
