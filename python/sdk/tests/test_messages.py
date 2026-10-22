from __future__ import annotations

import json
import sys
import threading
from pathlib import Path

import pytest
from pydantic import ValidationError

import deepseek_harness as sdk
from deepseek_harness import (
    DeepSeekHarness, HarnessClient, HarnessConfig, JsonRpcError, MessageAddress,
    MessageQuery, MessageStateEvent, SdkProtocolError, SendMessageRequest, Session,
    TransportClosedError,
)


RECIPIENT = {
    "nodeId": "node-a", "sessionId": "session-a", "window": "window-a",
    "title": "seat-a", "status": "idle", "matchedFields": ["sessionId"], "observedAt": 1,
}
STATUS = {
    "messageId": "message-a", "state": "queued", "phase": "pending",
    "revision": 0, "stateVersion": 1, "transitions": [],
}
SENT = {
    "messageId": "message-a", "operationId": "operation-a", "deliveryOutcome": "accepted",
    "messageState": "queued", "pending": False, "recipient": RECIPIENT,
}
CONTROL = {"messageId": "message-a", "operationId": "operation-a", "expectedRevision": 0}
APPLIED = {"kind": "applied", "messageId": "message-a", "operationId": "operation-a", "status": STATUS}
SEND = {"target": {"sessionId": "session-a"}, "messageClass": "handoff", "content": "Review this item", "operationId": "operation-a"}
SETTINGS = {"receiveMode": "all", "wakeOnHandoff": True}
RESOLVED = {"kind": "resolved", "address": {"sessionId": "session-a"}, "recipient": RECIPIENT}
EVENT = {
    "cursor": "cursor-a", "nodeId": "node-a", "data": {
        "messageId": "message-a", "senderSessionId": None, "targetSessionId": "session-a",
        "priority": "steer", "messageClass": "handoff", "state": "queued", "revision": 0,
        "stateVersion": 1, "operationId": "operation-a", "transition": "accepted", "observedAt": 1,
    },
}
CASES = [
    ("send", "send", SEND, SENT, {**SEND, "priority": "steer"}),
    ("withdraw", "withdraw", CONTROL, APPLIED, CONTROL),
    ("edit", "edit", {**CONTROL, "content": "Updated"}, APPLIED, {**CONTROL, "content": "Updated"}),
    ("reprioritize", "reprioritize", {**CONTROL, "priority": "immediate"}, APPLIED, {**CONTROL, "priority": "immediate"}),
    ("invalidate", "invalidate", {**CONTROL, "reason": "Superseded"}, APPLIED, {**CONTROL, "reason": "Superseded"}),
    ("status", "status", "message-a", STATUS, {"messageId": "message-a"}),
    ("operation_status", "operationStatus", "operation-a", {"kind": "not-found", "operationId": "operation-a"}, {"operationId": "operation-a"}),
    ("list", "list", {"from": 1, "to": 2, "cursor": "cursor-a", "limit": 2}, {"items": [STATUS], "complete": False, "nextCursor": "cursor-b"}, {"from": 1, "to": 2, "cursor": "cursor-a", "limit": 2}),
    ("resolve", "resolve", [{"sessionId": "session-a"}], [RESOLVED], {"addresses": [{"sessionId": "session-a"}]}),
    ("send_batch", "sendBatch", {"messageClass": "notice", "content": "Notice", "recipients": [{"target": {"name": "seat-a"}, "operationId": "operation-a"}], "dryRun": True}, {"kind": "resolved", "recipients": [RESOLVED]}, {"messageClass": "notice", "content": "Notice", "recipients": [{"target": {"name": "seat-a"}, "operationId": "operation-a"}], "dryRun": True, "priority": "queue"}),
    ("configure", "configure", {"sessionId": "session-a", "settings": SETTINGS}, SETTINGS, {"sessionId": "session-a", "settings": SETTINGS}),
    ("subscribe", "subscribe", {"sessionId": "session-a", "cursor": "cursor-a"}, {"cursor": "cursor-a"}, {"sessionId": "session-a", "cursor": "cursor-a"}),
]


@pytest.fixture
def runtime(tmp_path: Path):
    script = tmp_path / "runtime.py"
    script.write_text('''import json, sys
config = json.loads(sys.argv[1])
count = 0
def emit(message):
    print(json.dumps({"jsonrpc": "2.0", **message}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    with open(sys.argv[2], "a") as output:
        output.write(json.dumps(request) + "\\n")
    method = request["method"]
    result = {}
    if method == "initialize":
        result = {"serverInfo": {"name": "fixture", "version": "1"}}
        if "version" in config:
            result["messagesVersion"] = config["version"]
    elif method == "session/prompt":
        result = {"messageId": "legacy-message"}
    elif method.startswith("messages/"):
        if method == "messages/subscribe":
            batches = config.get("notifications", [])
            for notification in batches[count] if count < len(batches) else []:
                emit(notification)
            count += 1
        if config.get("disconnect"):
            break
        if "error" in config:
            emit({"id": request["id"], "error": config["error"]})
            continue
        result = config.get("result", {})
    emit({"id": request["id"], "result": result})
    if method == "shutdown":
        break
''', encoding="utf-8")
    count = 0

    def create(config=None, *, high=False):
        nonlocal count
        transcript = tmp_path / f"requests-{count}.jsonl"
        count += 1
        options = {"version": 1, **(config or {})}
        if options["version"] == "omitted":
            del options["version"]
        args = (sys.executable, str(script), json.dumps(options), str(transcript))
        if high:
            client = DeepSeekHarness(cwd=str(tmp_path), provider="mock", model="model-a", request_timeout_seconds=2, _launch_args=args)
        else:
            client = HarnessClient(HarnessConfig(request_timeout_seconds=2), _launch_args=args)
            client.start()
            try:
                client.initialize(cwd=str(tmp_path), provider="mock", model="model-a")
            except BaseException:
                client.close()
                raise
        return client, transcript

    return create


def dump(result):
    if isinstance(result, list):
        return [dump(item) for item in result]
    return result.model_dump(mode="json", by_alias=True, exclude_unset=True)


@pytest.mark.parametrize("name,wire,argument,result,expected", CASES, ids=[row[0] for row in CASES])
@pytest.mark.parametrize("high", [False, True], ids=["low", "high"])
def test_each_method_encodes_and_decodes(runtime, name, wire, argument, result, expected, high):
    owner, transcript = runtime({"result": result}, high=high)
    try:
        value = getattr(owner.messages, name)(argument)
        if name == "subscribe":
            assert value.cursor == "cursor-a"
            value.close()
        else:
            assert dump(value) == result
    finally:
        owner.close()
    requests = [json.loads(line) for line in transcript.read_text().splitlines()]
    assert requests[0]["params"]["messagesVersion"] == 1
    assert requests[1]["method"] == "messages/" + wire
    assert requests[1]["params"] == expected
    assert requests[-1]["method"] == "shutdown"
    assert not any("unsubscribe" in item["method"] for item in requests)


@pytest.mark.parametrize("name,wire,argument,result,expected", CASES, ids=[row[0] for row in CASES])
@pytest.mark.parametrize("failure", ["rpc", "invalid", "unsupported", "disconnect"])
def test_each_method_reports_errors(runtime, name, wire, argument, result, expected, failure):
    config = {"result": None}
    error_type = SdkProtocolError
    if failure == "rpc":
        config["error"] = {"code": -32603, "message": "Unavailable", "data": {"reason": "unavailable"}}
        error_type = JsonRpcError
    elif failure == "unsupported":
        config["version"] = "omitted"
        error_type = JsonRpcError
    elif failure == "disconnect":
        config["disconnect"] = True
        error_type = TransportClosedError
    client, transcript = runtime(config)
    try:
        with pytest.raises(error_type) as caught:
            getattr(client.messages, name)(argument)
        if failure in {"rpc", "unsupported"}:
            assert caught.value.code == (-32601 if failure == "unsupported" else -32603)
            assert caught.value.data == {"reason": "unsupported" if failure == "unsupported" else "unavailable"}
        assert client._notification_subscribers == {}
    finally:
        client.close()
    if failure == "unsupported":
        assert not any(json.loads(line)["method"].startswith("messages/") for line in transcript.read_text().splitlines())


@pytest.mark.parametrize("version", ["omitted", 2])
def test_legacy_prompt_remains_queued_without_message_capability(runtime, version):
    client, transcript = runtime({"version": version})
    try:
        assert client.session_prompt("session-a", [{"type": "text", "text": "Continue"}]) == "legacy-message"
        with pytest.raises(JsonRpcError, match="unsupported"):
            client.messages.send(SEND)
    finally:
        client.close()
    prompt = [json.loads(line) for line in transcript.read_text().splitlines()][1]
    assert prompt["method"] == "session/prompt"
    assert prompt["params"] == {"sessionId": "session-a", "contentBlocks": [{"type": "text", "text": "Continue"}]}


@pytest.mark.parametrize("version", [0, -1, True, "1", 1.5])
def test_invalid_negotiated_versions_fail(runtime, version):
    with pytest.raises(ValidationError):
        runtime({"version": version})


@pytest.mark.parametrize("message_class,priority,expected", [
    ("handoff", None, "steer"), ("reply", None, "steer"), ("notice", None, "queue"),
    ("handoff", "queue", "queue"), ("handoff", "steer", "steer"), ("handoff", "immediate", "immediate"),
])
def test_send_defaults_and_explicit_priorities(runtime, message_class, priority, expected):
    request = {**SEND, "messageClass": message_class}
    if message_class == "reply":
        request["replyTo"] = "original-message"
    model = SendMessageRequest(**request, priority=priority)
    client, transcript = runtime({"result": SENT})
    try:
        client.messages.send(model)
    finally:
        client.close()
    assert [json.loads(line) for line in transcript.read_text().splitlines()][1]["params"]["priority"] == expected
    assert model.priority == priority


@pytest.mark.parametrize("name,argument", [
    ("send", {**SEND, "sender": {"kind": "human", "sessionId": None}}),
    ("send", {**SEND, "senderSessionId": "session-b"}),
    ("send", {**SEND, "target": {"sessionId": "session-a", "name": "seat-a"}}),
    ("send", {**SEND, "messageClass": "reply"}),
    ("send", {**SEND, "replyTo": "message-b"}),
    ("send", {**SEND, "priority": "urgent"}),
    ("withdraw", {**CONTROL, "expectedRevision": True}),
    ("edit", {**CONTROL, "content": ""}),
    ("reprioritize", {**CONTROL, "priority": "urgent"}),
    ("invalidate", {**CONTROL, "reason": ""}),
    ("status", ""), ("operation_status", ""),
    ("list", {"limit": 0}), ("list", {"from": float("inf")}),
    ("resolve", [{"name": ""}]),
    ("send_batch", {"messageClass": "handoff", "content": "Text", "recipients": [], "dryRun": "yes"}),
    ("configure", {"sessionId": "session-a", "settings": {"receiveMode": "all"}}),
    ("subscribe", {"sessionId": "session-a", "cursor": ""}),
])
def test_invalid_requests_never_reach_wire(runtime, name, argument):
    client, transcript = runtime()
    try:
        with pytest.raises(ValidationError):
            getattr(client.messages, name)(argument)
    finally:
        client.close()
    assert [json.loads(line)["method"] for line in transcript.read_text().splitlines()] == ["initialize", "shutdown"]


def notification(event):
    return {"method": "messages.state", "params": event}


def test_notifications_before_admission_are_filtered_and_resume_after_cursor(runtime):
    unrelated = {**EVENT, "cursor": "other", "data": {**EVENT["data"], "targetSessionId": "session-b"}}
    event_b = {**EVENT, "cursor": "cursor-b", "data": {**EVENT["data"], "senderSessionId": "session-a", "targetSessionId": "session-b"}}
    event_c = {**EVENT, "cursor": "cursor-c"}
    client, transcript = runtime({"notifications": [
        [notification(unrelated), notification(EVENT), notification(EVENT), notification(event_b)],
        [notification(event_b), notification(event_c), {"method": "messages.error", "params": {"sessionId": "session-a", "reason": "unavailable"}}],
    ]})
    try:
        with client.messages.subscribe({"sessionId": "session-a"}) as stream:
            assert isinstance(next(stream), MessageStateEvent)
            assert stream.next().cursor == "cursor-b"
            cursor = stream.cursor
        with pytest.raises(StopIteration):
            next(stream)
        with client.messages.subscribe({"sessionId": "session-a", "cursor": cursor}) as resumed:
            assert resumed.next().cursor == "cursor-c"
            with pytest.raises(JsonRpcError) as caught:
                resumed.next()
            assert caught.value.data == {"reason": "unavailable", "cursor": "cursor-c"}
        assert client._notification_subscribers == {}
    finally:
        client.close()
    requests = [json.loads(line) for line in transcript.read_text().splitlines()]
    assert requests[2]["params"] == {"sessionId": "session-a", "cursor": "cursor-b"}


@pytest.mark.parametrize("bad", [
    notification({**EVENT, "data": {**EVENT["data"], "revision": True}}),
    {"method": "messages.error", "params": {"sessionId": "session-a", "reason": "invalid"}},
])
def test_invalid_notifications_close_stream(runtime, bad):
    client, _ = runtime({"notifications": [[bad]]})
    try:
        stream = client.messages.subscribe({"sessionId": "session-a"})
        with pytest.raises(SdkProtocolError):
            stream.next()
        assert stream.cursor is None
        assert client._notification_subscribers == {}
    finally:
        client.close()


def test_closing_stream_unblocks_pending_next(runtime):
    client, _ = runtime()
    stream = client.messages.subscribe({"sessionId": "session-a"})
    started = threading.Event()
    stopped = threading.Event()

    def consume():
        started.set()
        try:
            next(stream)
        except StopIteration:
            stopped.set()

    thread = threading.Thread(target=consume)
    thread.start()
    try:
        assert started.wait(2)
        stream.close()
        thread.join(2)
        assert stopped.is_set()
        assert not thread.is_alive()
    finally:
        stream.close()
        client.close()
        thread.join(2)


def test_session_facade_defaults_target_without_sender_attribution(runtime):
    harness, transcript = runtime({"result": SENT}, high=True)
    try:
        session = Session(harness, "session-a")
        request = {key: value for key, value in SEND.items() if key != "target"}
        session.messages.send(request)
        session.messages.send({**request, "target": {"name": "seat-b"}})
        assert "target" not in request
    finally:
        harness.close()
    requests = [json.loads(line) for line in transcript.read_text().splitlines()]
    assert requests[1]["params"]["target"] == {"sessionId": "session-a"}
    assert requests[2]["params"]["target"] == {"name": "seat-b"}
    assert all("senderSessionId" not in item.get("params", {}) and "sender" not in item.get("params", {}) for item in requests)


@pytest.mark.parametrize("name,argument,result", [
    ("list", {}, {"items": [], "complete": True}),
    ("configure", {"settings": SETTINGS}, SETTINGS),
    ("subscribe", {}, {}),
])
def test_session_facade_defaults_session_queries(runtime, name, argument, result):
    harness, transcript = runtime({"result": result}, high=True)
    try:
        session = Session(harness, "session-a")
        value = getattr(session.messages, name)(argument)
        if name == "subscribe":
            value.close()
    finally:
        harness.close()
    assert [json.loads(line) for line in transcript.read_text().splitlines()][1]["params"] == {"sessionId": "session-a", **argument}


@pytest.mark.parametrize("result", [
    {"kind": "accepted-pending-owner", "operationId": "operation-a", "messageId": "message-a", "state": "queued", "revision": 0},
    {"kind": "rejected", "operationId": "operation-a", "messageId": "message-a", "reason": "claimed", "status": STATUS},
    {"kind": "rejected", "operationId": "operation-a", "messageId": "message-a", "reason": "message-not-found", "status": None},
])
def test_control_outcomes_remain_distinct(runtime, result):
    client, _ = runtime({"result": result})
    try:
        assert dump(client.messages.withdraw(CONTROL)) == result
        assert dump(client.messages.operation_status("operation-a")) == result
    finally:
        client.close()


@pytest.mark.parametrize("result", [
    {**SENT, "deliveryOutcome": "rejected", "reason": "target-closed-pending", "pending": True},
    {"messageId": "message-a", "operationId": "operation-a", "deliveryOutcome": "rejected", "reason": "target-ambiguous", "messageState": "rejected", "pending": False, "candidates": [RECIPIENT]},
])
def test_send_rejections_preserve_pending_and_candidates(runtime, result):
    client, _ = runtime({"result": result})
    try:
        assert dump(client.messages.send(SEND)) == result
    finally:
        client.close()


@pytest.mark.parametrize("name,argument,result", [
    ("send", SEND, {**SENT, "deliveryOutcome": "rejected", "reason": "target-closed-pending", "pending": False}),
    ("withdraw", CONTROL, {**APPLIED, "status": {**STATUS, "stateVersion": "1"}}),
    ("status", "message-a", {**STATUS, "transitions": [{**EVENT, "cursor": ""}]}),
    ("list", {}, {"items": [], "complete": "yes"}),
    ("resolve", [], [{"kind": "rejected", "address": {"name": "seat-a"}, "reason": "target-ambiguous"}]),
    ("send_batch", CASES[9][2], {"kind": "sent", "results": [{}]}),
    ("subscribe", {"sessionId": "session-a"}, {"cursor": 1}),
])
def test_malformed_nested_results_are_protocol_errors(runtime, name, argument, result):
    client, _ = runtime({"result": result})
    try:
        with pytest.raises(SdkProtocolError):
            getattr(client.messages, name)(argument)
        assert client._notification_subscribers == {}
    finally:
        client.close()


def test_batch_sent_and_resolution_rejected_variants(runtime):
    rejected = {"kind": "rejected", "address": {"name": "seat-a"}, "reason": "target-ambiguous", "candidates": [RECIPIENT]}
    for name, argument, result in [
        ("resolve", [{"name": "seat-a"}], [rejected]),
        ("send_batch", {**CASES[9][2], "dryRun": False}, {"kind": "sent", "results": [SENT]}),
    ]:
        client, _ = runtime({"result": result})
        try:
            assert dump(getattr(client.messages, name)(argument)) == result
        finally:
            client.close()


def test_closed_client_drops_negotiated_capability(runtime):
    client, _ = runtime({"result": SENT})
    client.close()
    with pytest.raises(JsonRpcError) as caught:
        client.messages.send(SEND)
    assert caught.value.data == {"reason": "unsupported"}


def test_typed_query_alias_and_public_exports(runtime):
    client, transcript = runtime({"result": {"items": [], "complete": True}})
    try:
        client.messages.list(MessageQuery(from_=1, senderSessionId="session-a"))
    finally:
        client.close()
    assert [json.loads(line) for line in transcript.read_text().splitlines()][1]["params"] == {"from": 1, "senderSessionId": "session-a"}
    assert len(sdk.__all__) == len(set(sdk.__all__))
    assert all(hasattr(sdk, name) for name in sdk.__all__)
    assert MessageAddress(name="seat-a").name == "seat-a"
