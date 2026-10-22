import json
import sys
from pathlib import Path

from deepseek_harness import (
    HarnessClient,
    InitializeExecutionPolicy,
    InitializeLedgerContext,
    LlmCacheControl,
)


def test_optional_handshake_fields_and_legacy_omission(tmp_path: Path) -> None:
    script = tmp_path / "runtime.py"
    transcript = tmp_path / "initialize.jsonl"
    script.write_text('''import json, sys
for line in sys.stdin:
    request = json.loads(line)
    if request["method"] == "initialize":
        with open(sys.argv[1], "a") as output:
            output.write(json.dumps(request["params"]) + "\\n")
        result = {"serverInfo": {"name": "fixture", "version": "1"}}
    else:
        result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
    if request["method"] == "shutdown":
        break
''')
    fields = dict(
        agent_preset="worker",
        execution_policy=InitializeExecutionPolicy(presetId="worker", version="1", digest="a" * 64),
        ledger_context=InitializeLedgerContext(
            seat="seat", window="window", nodeId="node", identitySource="inherited",
            parentSessionId="parent", rootSessionId="root", subagentRunId="run",
            parentRunId="parent-run", childSessionId="child",
        ),
        cache_policy=LlmCacheControl(retention="1h"),
    )
    for options in ({}, fields):
        with HarnessClient(_launch_args=(sys.executable, str(script), str(transcript))) as client:
            client.initialize(cwd="/workspace", provider="mock", model="mock", **options)
    old, new = [json.loads(line) for line in transcript.read_text().splitlines()]
    assert not {"agentPreset", "executionPolicy", "ledgerContext", "cachePolicy"}.intersection(old)
    assert new["agentPreset"] == "worker"
    assert new["executionPolicy"] == {"presetId": "worker", "version": "1", "digest": "a" * 64}
    assert new["ledgerContext"]["childSessionId"] == "child"
    assert "taskId" not in new["ledgerContext"]
    assert new["cachePolicy"] == {"retention": "1h"}
