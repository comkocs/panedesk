"""Test-only process exercising the public low-level running-host mode."""
import json
import sys

from deepseek_harness import HarnessClient, HarnessConfig, JsonRpcError, RunningHostConfig

client = HarnessClient(HarnessConfig(running_host=RunningHostConfig(
    endpoint_path=sys.argv[1], credential_path=sys.argv[2], max_frame_bytes=65536,
    request_timeout_seconds=5)))
try:
    client.start()
    result = client.request(sys.argv[3], {"sessionId": "forged-session", "seat": "forged-seat", "by": "forged-staff"})
    assert client._proc is None
    print(json.dumps({"status": "ok", "result": result}))
except JsonRpcError as error:
    print(json.dumps({"status": "rejected", "data": error.data}))
except Exception:
    print(json.dumps({"status": "rejected", "data": {"reason": "transport-refused"}}))
finally:
    client.close()
