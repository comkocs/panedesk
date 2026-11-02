"""Exercise Python SDK reply attempts against the production server test relay."""

import json
import sys

from deepseek_harness.client import HarnessClient, HarnessConfig
from deepseek_harness.errors import JsonRpcError


def main() -> None:
    """Use the SDK transport, without loading a provider or sending a prompt."""
    node, relay, port, workspace = sys.argv[1:]
    client = HarnessClient(
        HarnessConfig(request_timeout_seconds=5),
        _launch_args=(node, relay, port),
    )
    try:
        client.start()
        client.request("initialize", {"cwd": workspace, "provider": "approval-test", "model": "test"})
        client.respond("forged-approval", "allowed-once")
        client.notify("$events/result", {"outcome": {"kind": "result", "value": "allowed-once"}})
        rejected = []
        for method in ("$events/result", "approval/request", "approval/respond"):
            try:
                client.request(method, {"result": {"type": "return", "value": "allowed-once"}})
            except JsonRpcError as error:
                if "unknown Panedesk SDK runtime method" not in str(error):
                    raise
                rejected.append(method)
            else:
                raise AssertionError(f"Unexpected approval reply acceptance: {method}")
        print(json.dumps({"rejected": rejected}))
    finally:
        client.close()


if __name__ == "__main__":
    main()
