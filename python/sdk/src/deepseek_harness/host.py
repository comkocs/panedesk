"""Transport-neutral node and authorization queries; evidence never grants authority."""
from __future__ import annotations

from typing import Annotated, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .errors import SdkProtocolError
from .models import JsonObject, JsonValue, SeatCursor, SeatFailure

Text = Annotated[str, Field(min_length=1)]
Integer = Annotated[int, Field(ge=0, le=9007199254740991)]
AuthorizationKind = Literal["model-tool-call", "human", "engine", "local-operator", "node-delegation"]


class AuthorizationQuery(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    limit: Annotated[int, Field(gt=0, le=9007199254740991)]
    taskId: Text | None = None
    seat: Text | None = None
    nodeId: Text | None = None
    kind: AuthorizationKind | None = None
    from_: Text | None = Field(default=None, alias="from")
    to: Text | None = None
    cursor: SeatCursor | None = None


class AuthorizationFact(BaseModel):
    model_config = ConfigDict(strict=True)
    authorizationId: Text
    kind: AuthorizationKind
    principalId: Text
    origin: Literal["manual", "remote", "engine"]
    nodeId: Text
    sourceNodeId: Text | None = None
    sessionId: Text | None = None
    seat: Text | None = None
    taskIds: list[Text]
    operationId: Text
    callId: Text | None = None
    rootCallId: Text | None = None
    policyRevision: Integer
    decision: Literal["allowed", "denied"]
    reasonCode: Text
    requestDigest: Text
    delegatedBy: Text | None = None
    checkedAt: Text


class AuthorizationPage(BaseModel):
    model_config = ConfigDict(strict=True)
    facts: list[AuthorizationFact]
    complete: bool
    watermark: Integer
    nextCursor: SeatCursor | None = None
    legacyAttribution: Literal["legacy-unknown", "none"]


class NodeCapacity(BaseModel):
    model_config = ConfigDict(strict=True)
    nodeId: Text
    nodeName: Text
    engine: Literal["running", "recovering", "unavailable"]
    openEngineWindows: Integer
    limit: Integer | None
    readyAt: Text | None


class NodeStatus(BaseModel):
    model_config = ConfigDict(strict=True)
    nodeId: Text
    nodeName: Text
    reachable: bool
    linkState: Literal["connected", "disconnected", "connecting", "stale"]
    observedAt: Text
    status: NodeCapacity | None
    capabilities: list[str]
    safeReason: str | None


class HostClient:
    """Reuse an existing JSON request transport without retries or a second host."""

    def __init__(self, request: Callable[[str, JsonObject], JsonValue]) -> None:
        self._request = request

    def list_nodes(self) -> list[JsonObject]:
        result = self._request("nodes/list", {})
        try:
            if not isinstance(result, list):
                raise ValueError("expected node list")
            for node in result:
                NodeStatus.model_validate(node)
        except (ValueError, ValidationError) as error:
            raise SdkProtocolError("Invalid node list") from error
        return result

    def node_status(self, node_id: str) -> JsonObject | None:
        if not node_id.strip():
            raise ValueError("node_id is required")
        result = self._request("nodes/status", {"nodeId": node_id})
        if result is not None:
            try:
                NodeStatus.model_validate(result)
            except ValidationError as error:
                raise SdkProtocolError("Invalid node status") from error
        return result

    def query_authorizations(self, request: AuthorizationQuery | JsonObject) -> JsonObject:
        payload = request.model_dump(mode="json", by_alias=True, exclude_none=True) if isinstance(request, AuthorizationQuery) else request
        payload = AuthorizationQuery.model_validate(payload).model_dump(mode="json", by_alias=True, exclude_none=True)
        result = self._request("authorizations/query", payload)
        try:
            if not isinstance(result, dict):
                raise ValueError("expected authorization page")
            if result.get("status") == "rejected":
                SeatFailure.model_validate(result.get("error"))
            else:
                AuthorizationPage.model_validate(result)
        except (ValueError, ValidationError) as error:
            raise SdkProtocolError("Invalid authorization query result") from error
        return result
