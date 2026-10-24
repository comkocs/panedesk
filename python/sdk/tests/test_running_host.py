"""Running-host mode preserves the low-level decoder and never launches a child."""
from pathlib import Path
from unittest.mock import patch

import pytest
from pydantic import BaseModel

from deepseek_harness import HarnessClient, HarnessConfig, RunningHostConfig, TransportClosedError
from deepseek_harness.running_host import _read_private


class Result(BaseModel):
    value: str


def test_running_host_uses_namespace_transport_and_response_model(tmp_path: Path) -> None:
    config = RunningHostConfig(str(tmp_path / "endpoint.json"), str(tmp_path / "credential"), 4096, 1)
    with patch("deepseek_harness.client.subprocess.Popen") as spawn:
        with patch("deepseek_harness.client.request_host", return_value={"value": "received"}) as request:
            with HarnessClient(HarnessConfig(running_host=config)) as client:
                result = client.request("example/read", {"sessionId": "untrusted"}, response_model=Result)
            assert result.value == "received"
            request.assert_called_once_with(config, "example/read", {"sessionId": "untrusted"}, None)
        spawn.assert_not_called()


def test_private_files_reject_permissions_links_and_oversize(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    credential = tmp_path / "credential"
    credential.write_text("private-test-data")
    credential.chmod(0o600)
    assert _read_private(str(credential), 64) == "private-test-data"
    with pytest.raises(TransportClosedError):
        _read_private(str(credential), 1)
    credential.chmod(0o644)
    with pytest.raises(TransportClosedError):
        _read_private(str(credential), 64)
    credential.chmod(0o600)
    link = tmp_path / "link"
    link.symlink_to(credential)
    with pytest.raises(OSError):
        _read_private(str(link), 64)


def test_missing_host_does_not_launch_fallback(tmp_path: Path) -> None:
    config = RunningHostConfig(str(tmp_path / "endpoint.json"), str(tmp_path / "credential"), 4096, 1)
    with patch("deepseek_harness.client.subprocess.Popen") as spawn:
        with HarnessClient(HarnessConfig(running_host=config)) as client:
            with pytest.raises(TransportClosedError, match="outcome unavailable"):
                client.request("example/read", {})
        spawn.assert_not_called()
