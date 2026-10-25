import json
from unittest.mock import Mock

import pytest
from pydantic import ValidationError

from deepseek_harness import HarnessClient, SeatsClient
from deepseek_harness.models import (SeatFailure, SeatFailureCause, SeatRemoteAdmission,
    SendMessageResult, validate_node_work_chain_request, validate_node_work_chain_result)

CAUSE = {"domain": "node-link", "code": "node-outcome-unknown", "reason": "Receipt unavailable",
    "effectState": "unknown", "retryable": False, "operationId": "operation-a", "nodeId": "node-b", "reasonCode": "outcome-unknown"}
ERROR = {"code": "unavailable", "message": "Unavailable", "alternative": "Query original operation", "retryable": False, "effectState": "unknown"}


def test_preserves_legacy_bytes_and_optional_cause_through_sdk() -> None:
    transport = Mock(spec=HarnessClient)
    seats = SeatsClient(transport)
    for error in [ERROR, {**ERROR, "cause": CAUSE}]:
        result = {"status": "rejected", "error": error}
        original = json.dumps(result)
        transport._request_raw.return_value = result
        assert json.dumps(seats.open({"seat": "seat-a", "operationId": "operation-a"})) == original
        assert SeatFailure.model_validate(error).model_dump(exclude_unset=True) == error
    with pytest.raises(ValidationError):
        SeatFailure.model_validate({**ERROR, "cause": CAUSE, "unexpected": True})
    message = {"messageId": "message-a", "operationId": "operation-a", "deliveryOutcome": "rejected",
        "messageState": "rejected", "pending": False, "reason": "unavailable", "candidates": []}
    for result in [message, {**message, "cause": CAUSE}]:
        assert SendMessageResult.model_validate(result).model_dump(exclude_unset=True) == result


@pytest.mark.parametrize("patch", [
    {"code": "a" * 129}, {"code": "a b"}, {"code": "é"}, {"code": ""},
    {"reason": "é" * 257}, {"reason": "a" * 513}, {"reason": "line\nfeed"},
    {"reasonCode": "invented"}, {"extra": True}, {"domain": "x" * 129},
])
def test_rejects_invalid_or_oversized_cause_without_truncation(patch: dict) -> None:
    with pytest.raises(ValidationError):
        SeatFailureCause.model_validate({**CAUSE, **patch})


def test_accepts_exact_ascii_and_utf8_limits() -> None:
    value = {**CAUSE, "code": "a" * 128, "reason": "é" * 256}
    assert SeatFailureCause.model_validate(value).model_dump(exclude_unset=True) == value


def test_remote_permission_is_explicit_and_unique() -> None:
    value = {"allowOpen": True, "sourceNodeIds": ["node-a"], "sourceIds": ["source-a"],
        "principalIds": ["principal-a"], "methods": ["seat.openFrozen"], "policyRevision": 1}
    assert SeatRemoteAdmission.model_validate(value).model_dump() == value
    for patch in [{"allowOpen": False}, {"sourceNodeIds": []}, {"sourceIds": ["*"]},
                  {"principalIds": ["a", "a"]}, {"methods": ["seat.open"]}, {"policyRevision": 0}]:
        with pytest.raises(ValidationError):
            SeatRemoteAdmission.model_validate({**value, **patch})


def test_decodes_seven_chain_methods_and_rejects_nested_unknown_fields() -> None:
    reference = {"providerId": "provider-a", "reference": "reference-a", "revision": "1"}
    reservation = {"reservationId": "reservation-a", "sourceId": "source-a", "sourceOwnerNodeId": "node-a",
        "ownerEpoch": "epoch-a", "operationId": "operation-a", "taskIds": ["task-a"], "snapshotDigest": "digest-a", "policyRevision": 1}
    context = {"snapshot": {"reference": reference, "text": "Frozen input", "digest": "digest-a", "revision": "1",
        "taskIds": ["task-a"], "scopeEvidence": []}, "scopeReservation": reservation, "openingMode": "auto"}
    route = {"sourceId": "source-a", "sourceOwnerNodeId": "node-a", "ownerEpoch": "epoch-a", "triggerId": None,
        "originalOperationId": "operation-a", "targetNodeId": "node-b", "snapshotDigest": "digest-a",
        "callbackPath": {"kind": "source", "sourceId": "source-a"},
        "modeCeiling": {"mode": "remind", "policy": {"sourceId": "source-a", "projectId": "project-a", "revision": 1}}}
    frozen = {"openingContext": context, "route": route, "expectedSeatRevision": 1}
    callback = {"kind": "opened", "callbackId": "callback-a", "sourceId": "source-a", "triggerId": None,
        "stateVersion": 1, "seat": "seat-a", "title": "Window", "sessionId": "session-a", "nodeId": "node-b",
        "nodeName": "target", "budget": {}, "relatedTaskIds": ["task-a"]}
    cases = [
        ("engine.acceptFrozen", {**frozen, "envelope": {"triggerId": "trigger-a", "sourceId": "source-a", "kind": "external",
            "evidence": {"kind": "external", "eventType": "ready"}, "seat": "seat-a", "projectId": "project-a",
            "receivedAt": "now", "dataDigest": "digest-a", "data": {}, "callbackRef": "source-a"}},
            {"status": "accepted", "triggerId": "trigger-a", "queueItemId": "queue-a", "sequence": 1}),
        ("seat.openFrozen", {**frozen, "request": {"seat": "seat-a", "operationId": "operation-a", "origin": "manual"}}, {"status": "cancelled"}),
        ("seat.wakeFrozen", {**frozen, "request": {"seat": "seat-a", "operationId": "operation-a"}}, {"status": "opened", "result": {"status": "cancelled"}}),
        ("source.prepareOpening", {"sourceId": "source-a", "sourceOwnerNodeId": "node-a", "ownerEpoch": "epoch-a", "reference": reference,
            "seat": "seat-a", "taskIds": ["task-a"], "operationId": "operation-a", "targetNodeId": "node-b", "expectedSeatRevision": 1,
            "openingMode": "auto"}, {"status": "prepared", **frozen}),
        ("source.checkAdmission", {"scopeReservation": reservation, "route": route, "taskIds": ["task-a"], "operationId": "operation-a", "executionNodeId": "node-b"},
            {"status": "unknown", "policyRevision": None, "error": {**ERROR, "cause": CAUSE}}),
        ("source.deliverCallback", {"callback": callback, "route": route, "modelEvidence": {"status": "missing", "sessionId": None, "nodeId": "node-b", "observedAt": "now"},
            "payloadDigest": "digest-a"}, {"status": "committed", "callbackId": "callback-a", "payloadDigest": "digest-a"}),
        ("chain.operation", {"key": {"sourceNodeId": "node-a", "principalId": "principal-a", "sourceId": "source-a", "ownerEpoch": "epoch-a",
            "method": "seat.openFrozen", "operationId": "operation-a"}, "payloadDigest": "digest-a"},
            {"status": "settled", "method": "seat.openFrozen", "result": {"status": "cancelled"}}),
    ]
    for method, request, result in cases:
        validate_node_work_chain_request(method, request)
        validate_node_work_chain_result(method, result)
        with pytest.raises(ValueError):
            validate_node_work_chain_request(method, {**request, "extra": True})
        with pytest.raises(ValueError):
            validate_node_work_chain_result(method, {"status": "invented"})
    with pytest.raises(ValueError):
        validate_node_work_chain_result("chain.operation", {"status": "settled", "method": "chain.operation", "result": {"status": "missing"}})
