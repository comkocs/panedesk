from unittest.mock import Mock

import pytest
from pydantic import ValidationError

from deepseek_harness import HarnessClient, HostClient, InitializeResponse
from deepseek_harness.errors import SdkProtocolError


def test_public_request_accepts_extension_json_without_a_response_model() -> None:
    client = HarnessClient()
    client._request_raw = Mock(return_value=[{"text": "hello"}])
    assert client.request("example/echo", {"text": "hello"}) == [{"text": "hello"}]
    client._request_raw.assert_called_once()


def test_namespace_handshake_is_optional_and_validated() -> None:
    assert InitializeResponse.model_validate({}).namespaces is None
    response = InitializeResponse.model_validate({"namespaces": [{"namespace": "example", "version": "1"}]})
    assert response.namespaces[0].namespace == "example"
    for value in [True, [{"namespace": "example", "version": ""}],
                  [{"namespace": "example", "version": "1"}] * 2]:
        with pytest.raises(ValidationError):
            InitializeResponse.model_validate({"namespaces": value})


def test_queries_preserve_stale_nodes_and_empty_advancing_pages() -> None:
    node = {"nodeId": "node-a", "nodeName": "node-a", "reachable": False,
            "linkState": "stale", "observedAt": "2026-01-01T00:00:00Z", "status": None,
            "capabilities": [], "safeReason": "unavailable"}
    cursor = {"nodeId": "node-a", "sequence": 4, "effectIndex": 1}
    page = {"facts": [], "complete": False, "watermark": 9,
            "nextCursor": cursor, "legacyAttribution": "legacy-unknown"}
    request = Mock(side_effect=[[node], None, page])
    host = HostClient(request)
    assert host.list_nodes() == [node]
    assert host.node_status("node-b") is None
    assert host.query_authorizations({"taskId": "task-a", "limit": 3, "cursor": cursor}) == page
    assert request.call_count == 3
    assert request.call_args.args == ("authorizations/query", {"taskId": "task-a", "limit": 3, "cursor": cursor})


def test_queries_reject_authority_fields_and_corrupt_pages_without_retry() -> None:
    request = Mock(return_value={"facts": [], "complete": False, "watermark": True,
                                 "legacyAttribution": "none"})
    host = HostClient(request)
    with pytest.raises(ValidationError):
        host.query_authorizations({"limit": 1, "principalId": "owner"})
    request.assert_not_called()
    with pytest.raises(SdkProtocolError):
        host.query_authorizations({"limit": 1})
    request.assert_called_once()
    request.return_value = {"status": "rejected"}
    with pytest.raises(SdkProtocolError):
        host.query_authorizations({"limit": 1})
