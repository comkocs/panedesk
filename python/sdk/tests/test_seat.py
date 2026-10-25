from unittest.mock import Mock

import pytest
from pydantic import ValidationError

from deepseek_harness import HarnessClient, OpenSeatBatchRequest, SeatsClient
from deepseek_harness.errors import SdkProtocolError


def test_cancel_preserves_legacy_bytes_and_transmits_only_valid_optional_reasons() -> None:
    transport = Mock(spec=HarnessClient)
    seats = SeatsClient(transport)
    request = {"queueItemId": "queue-a", "expectedStateVersion": 1, "operationId": "cancel-a"}
    result = {"status": "cancelled", "queueItemId": "queue-a", "stateVersion": 2}
    transport._request_raw.return_value = result
    assert seats.cancel(request) == result
    transport._request_raw.assert_called_once_with("seats/cancel", request)
    for reason in ["", "a" * 512, "é" * 256]:
        assert seats.cancel({**request, "reason": reason}) == result
        transport._request_raw.assert_called_with("seats/cancel", {**request, "reason": reason})
        with pytest.raises(ValidationError):
            seats.approve({**request, "reason": reason})
    for reason in ["a" * 513, "é" * 257, "\n", chr(0x85)]:
        with pytest.raises(ValidationError):
            seats.cancel({**request, "reason": reason})
    cancellation = {"authorizationId": "auth-a", "principalId": "operator-a", "kind": "local-operator",
                    "operationId": "cancel-a", "queueItemId": "queue-a", "cancelledAt": "2026-01-01T00:00:00Z",
                    "stateVersion": 2, "reasonPresent": True, "reason": "Stopped"}
    receipt = {"status": "settled", "result": {"status": "cancelled", "cancellation": cancellation}}
    transport._request_raw.return_value = receipt
    assert seats.operation({"operationId": "cancel-a"}) == receipt
    transport._request_raw.return_value = {**receipt, "result": {"status": "cancelled", "cancellation": {**cancellation, "reason": "\n"}}}
    with pytest.raises(SdkProtocolError):
        seats.operation({"operationId": "cancel-a"})


def test_projects_seat_operations_and_binding_without_changing_session_events() -> None:
    transport = Mock(spec=HarnessClient)
    queued = {"status": "queued", "queueItemId": "queue-a", "sequence": 2,
              "reason": "seat-capacity", "blockedBy": ["seat-a"]}
    binding = {"kind": "free", "sessionId": "session-a", "nodeId": "node-a", "identitySource": "free"}
    transport._request_raw.side_effect = [queued, binding]
    seats = SeatsClient(transport)
    assert seats.open({"seat": "seat-a", "operationId": "operation-a"}) == queued
    assert seats.binding({"sessionId": "session-a"}) == binding
    assert transport._request_raw.call_args_list[0].args == (
        "seats/open", {"seat": "seat-a", "operationId": "operation-a",
                       "origin": "remote", "openingMode": "auto"})
    assert [call.args[0] for call in transport._request_raw.call_args_list] == ["seats/open", "seats/binding"]


def test_explicit_batch_preserves_each_outcome_without_retry() -> None:
    transport = Mock(spec=HarnessClient)
    result = {"status": "processed", "results": [
        {"seat": seat, "result": {"status": "cancelled"}}
        for seat in ["seat-a", "seat-b", "seat-c"]]}
    transport._request_raw.side_effect = [result, RuntimeError("unavailable")]
    seats = SeatsClient(transport)
    assert seats.open_batch(OpenSeatBatchRequest(
        operationId="operation-a", seats=["seat-a", "seat-b", "seat-c"])) == result
    with pytest.raises(RuntimeError, match="unavailable"):
        seats.open({"seat": "seat-a", "operationId": "operation-b"})
    assert transport._request_raw.call_count == 2


@pytest.mark.parametrize("names", [[], ["all"], ["*"], ["seat-?"], ["seat-a", "seat-a"]])
def test_rejects_nonexplicit_batches_before_transport(names: list[str]) -> None:
    transport = Mock(spec=HarnessClient)
    with pytest.raises(ValidationError):
        SeatsClient(transport).open_batch({"seats": names, "operationId": "operation-a"})
    transport._request_raw.assert_not_called()


def test_projects_all_management_methods_and_rejects_nested_corruption() -> None:
    transport = Mock(spec=HarnessClient)
    seats = SeatsClient(transport)
    wait = {"waitId": "wait-a", "sessionId": "session-a", "mode": "all",
            "objects": [{"kind": "job", "id": "job-a"}], "observations": [],
            "phase": "registered", "operationId": "operation-a", "wakeOperationId": "wake-a",
            "stateVersion": 1, "durability": "durable"}
    report = {"reportId": "report-a", "sessionId": "session-a", "canClose": False,
              "waitingFor": [{"kind": "job", "objectId": "job-a", "summary": "Pending"}],
              "nextOpen": {"when": {"kind": "unspecified"}, "prerequisites": []},
              "submittedAt": "2026-01-01T00:00:00Z", "stateVersion": 1}
    cases = [
        (seats.preview_import, "import.preview",
         {"format": "csv", "sourcePath": "seats.csv", "columnMap": {"seat": "Name"}, "defaults": {}},
         {"planId": "plan-a", "sourceFileHash": "digest-a", "mappingHash": "digest-b", "baseRevision": 0, "rows": []}),
        (seats.commit_import, "import.commit",
         {"planId": "plan-a", "selectedRows": [1], "expectedRevision": 0, "operationId": "operation-a"},
         {"status": "committed", "revision": 1, "rows": []}),
        (seats.set_authority, "setAuthority",
         {"authority": "seat-store", "authorizationRef": "authorization-a", "expectedRevision": 1, "operationId": "operation-a"},
         {"status": "saved", "revision": 2}),
        (seats.submit_report, "report.submit", {"report": report, "operationId": "operation-a"},
         {"status": "recorded", "reportId": "report-a", "stateVersion": 1}),
        (seats.register_wait, "wait.register",
         {"waitId": "wait-a", "sessionId": "session-a", "mode": "all", "objects": wait["objects"], "operationId": "operation-a"},
         {"status": "registered", "wait": wait}),
        (seats.cancel_wait, "wait.cancel",
         {"waitId": "wait-a", "sessionId": "session-a", "expectedStateVersion": 1, "operationId": "operation-b"},
         {"status": "cancelled", "wait": {**wait, "phase": "cancelled"}}),
    ]
    for invoke, method, request, result in cases:
        transport.reset_mock()
        transport._request_raw.return_value = result
        assert invoke(request) == result
        transport._request_raw.assert_called_once_with("seats/" + method, request)
        with pytest.raises(ValidationError):
            invoke({**request, "principalId": "owner"})
        assert transport._request_raw.call_count == 1
        transport._request_raw.return_value = {}
        with pytest.raises(SdkProtocolError):
            invoke(request)
    transport._request_raw.return_value = {"status": "registered", "wait": {
        **wait, "observations": [{"outcome": "completed"}]}}
    with pytest.raises(SdkProtocolError):
        seats.register_wait(cases[4][2])


@pytest.mark.parametrize("auto_keep_alive", [True, False, None])
def test_accepts_auto_keep_alive_in_import_defaults_and_definitions(auto_keep_alive: bool | None) -> None:
    transport = Mock(spec=HarnessClient)
    seats = SeatsClient(transport)
    definition = {
        "schemaVersion": 1, "revision": 1, "seat": "seat-a", "platform": "server", "node": "node-a",
        "projectId": "project-a", "directories": [{"path": "/workspace", "startup": True}],
        "memoryDirectories": [], "opening": {"kind": "text", "text": "Start"}, "openingInstructionFiles": [],
        "agentPreset": "default", "provider": "provider-a", "model": "model-a", "reasoningEffort": "high",
        "permissionPreset": "default", "subscriptions": [], "checkpointFiles": [], "maxOpenSessions": 1,
        "maxActiveSubagents": 1, "subagentContextThresholdTokens": 1000, "rules": [],
        "worktree": {"clientTreesPerSlot": 1, "staleOnSettle": "notify", "lightByDefault": True, "staleHours": 24},
    }
    if auto_keep_alive is not None:
        definition["autoKeepAlive"] = auto_keep_alive
    preview_request = {"format": "csv", "sourcePath": "seats.csv", "columnMap": {"Name": "seat"}, "defaults": definition}
    row = {"row": 1, "seat": "seat-a", "definition": definition, "rowHash": "digest-a", "columnHashes": {},
           "action": "create", "selected": True, "differences": [], "diagnostics": []}
    cases = [
        (seats.preview_import, "import.preview", preview_request,
         {"planId": "plan-a", "sourceFileHash": "digest-a", "mappingHash": "digest-b", "baseRevision": 0, "rows": [row]}),
        (seats.commit_import, "import.commit",
         {"planId": "plan-a", "selectedRows": [1], "expectedRevision": 0, "operationId": "operation-a"},
         {"status": "committed", "revision": 1, "rows": [row]}),
    ]
    malformed_definitions = [{**definition, "unknownField": True}] + [
        {**definition, "autoKeepAlive": invalid} for invalid in ["false", 0, None, {}, []]]
    for invoke, method, request, result in cases:
        transport.reset_mock()
        transport._request_raw.return_value = result
        assert invoke(request) == result
        transport._request_raw.assert_called_once_with("seats/" + method, request)
        for malformed in malformed_definitions:
            transport._request_raw.return_value = {**result, "rows": [{**row, "definition": malformed}]}
            with pytest.raises(SdkProtocolError):
                invoke(request)
    for malformed in malformed_definitions:
        transport.reset_mock()
        with pytest.raises(ValidationError):
            seats.preview_import({**preview_request, "defaults": malformed})
        transport._request_raw.assert_not_called()


def test_preserves_opened_fields_and_rejects_nested_window_and_engine_evidence() -> None:
    transport = Mock(spec=HarnessClient)
    seats = SeatsClient(transport)
    opened = {"status": "opened", "sessionId": "session-a", "seat": "seat-a", "nodeId": "node-a", "nodeName": "node-a",
              "title": "", "budget": {"windowBudgetUsd": "1000"}, "phase": "active", "stateVersion": 1, "callbackIds": ["callback-a"]}
    transport._request_raw.return_value = opened
    assert seats.open({"seat": "seat-a", "operationId": "operation-a"}) == opened
    transport._request_raw.return_value = None
    assert seats.binding({"sessionId": "session-a"}) is None
    from deepseek_harness.models import validate_seat_result
    cases = [
        ("open", {**opened, "budget": {"windowBudgetUsd": 1000}}),
        ("open", {**opened, "callbackIds": [1]}),
        ("list", {"status": "listed", "sessions": [{}], "unopenedSeats": [], "snapshotAt": "2026-01-01T00:00:00Z", "complete": True}),
        ("binding", {"kind": "seat", "sessionId": "session-a", "nodeId": "node-a"}),
        ("renew", {"status": "renewed", "sessionId": "session-a", "cacheEvidence": {}}),
        ("close", {"status": "busy", "sessionId": "session-a", "busyReasons": [{"kind": "unknown"}]}),
        ("replace", {"status": "replacing", "replacementId": "replacement-a", "oldSessionId": "session-a", "newSessionId": "session-b", "phase": "opening", "permit": {}}),
        ("rename", {"status": "renamed", "sessionId": "session-a", "title": {"title": "Window"}}),
        ("wake", {"status": "opened", "result": {**opened, "phase": "invented"}}),
        ("operation", {"status": "settled", "result": {"status": "renewed"}}),
        ("setProjectMode", {"status": "saved", "policy": {"projectId": "project-a", "mode": "auto", "revision": 1}}),
        ("pending", {"items": [{}], "complete": True, "watermark": 1}),
        ("gates", {"gates": [{}], "complete": True, "watermark": 1}),
        ("nodeStatus", {"nodeId": "node-a", "nodeName": "node-a", "engine": "running", "openEngineWindows": 0, "limit": None}),
    ]
    for method, result in cases:
        with pytest.raises(ValueError):
            validate_seat_result(method, result)


@pytest.mark.parametrize("name", ["all", "*", "seat-?", "seat-" + chr(1)])
def test_rejects_nonexplicit_single_seat_before_transport(name: str) -> None:
    transport = Mock(spec=HarnessClient)
    with pytest.raises(ValidationError):
        SeatsClient(transport).open({"seat": name, "operationId": "operation-a"})
    transport._request_raw.assert_not_called()


def test_rejects_unknown_response_and_authority_injection() -> None:
    transport = Mock(spec=HarnessClient)
    seats = SeatsClient(transport)
    with pytest.raises(ValidationError):
        seats.open({"seat": "seat-a", "operationId": "operation-a", "principalId": "owner"})
    transport._request_raw.assert_not_called()
    transport._request_raw.return_value = {"status": "invented"}
    with pytest.raises(SdkProtocolError, match="Invalid seats/open result"):
        seats.open({"seat": "seat-a", "operationId": "operation-a"})
