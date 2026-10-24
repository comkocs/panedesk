"""Owner-checked files authenticate namespace calls without launching a runtime."""
from __future__ import annotations

import http.client
import json
import os
import re
import stat
import uuid
from dataclasses import dataclass
from pathlib import Path

from .errors import JsonRpcError, TransportClosedError
from .models import JsonObject, JsonValue


@dataclass(frozen=True, slots=True)
class RunningHostConfig:
    """Explicit private paths and complete-frame/deadline bounds for an existing host."""

    endpoint_path: str
    credential_path: str
    max_frame_bytes: int
    request_timeout_seconds: float


def _read_private(path: str, limit: int) -> str:
    target = Path(path)
    if not target.is_absolute() or os.name != "posix":
        raise TransportClosedError("Private file policy unavailable")
    for parent in target.parents:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise TransportClosedError("Private path rejected")
    parent_info = target.parent.lstat()
    if parent_info.st_uid != os.getuid() or stat.S_IMODE(parent_info.st_mode) != 0o700:
        raise TransportClosedError("Private directory ownership or permissions rejected")
    fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size > limit):
            raise TransportClosedError("Private file ownership or permissions rejected")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise TransportClosedError("Private file exceeds limit")
        return data.decode("utf-8", errors="strict")
    finally:
        os.close(fd)


def request_host(config: RunningHostConfig, method: str, params: JsonObject | None,
                 timeout_seconds: float | None = None) -> JsonValue:
    """Send exactly once; errors never include authentication material or private payloads."""
    parts = method.split("/")
    if len(parts) != 2 or not all(re.fullmatch(r"[A-Za-z][A-Za-z0-9._-]*", part) for part in parts):
        raise JsonRpcError(-32601, "Running host method unavailable", {"reason": "method-unavailable"})
    if config.max_frame_bytes < 1 or config.request_timeout_seconds <= 0:
        raise ValueError("Running host bounds must be positive")
    connection: http.client.HTTPConnection | None = None
    try:
        endpoint = json.loads(_read_private(config.endpoint_path, config.max_frame_bytes))
        credential = _read_private(config.credential_path, 64)
        if (not isinstance(endpoint, dict) or endpoint.get("version") != "host-admin/v1"
                or not isinstance(endpoint.get("processEpoch"), str) or not endpoint["processEpoch"]
                or not isinstance(endpoint.get("nodeId"), str) or not endpoint["nodeId"]
                or type(endpoint.get("pid")) is not int or endpoint["pid"] < 1
                or type(endpoint.get("port")) is not int or not 1 <= endpoint["port"] <= 65535
                or endpoint.get("credentialRef") != "credential" or not re.fullmatch(r"[a-f0-9]{64}", credential)):
            raise TransportClosedError("Running host endpoint rejected")
        request_id = str(uuid.uuid4())
        payload = json.dumps({"version": "host-admin/v1", "requestId": request_id,
                              "processEpoch": endpoint["processEpoch"], "nonce": str(uuid.uuid4()),
                              "method": "sdk.invoke", "params": {"namespace": parts[0], "method": parts[1],
                                                                    "params": params or {}}}, allow_nan=False).encode("utf-8")
        if len(payload) > config.max_frame_bytes:
            raise TransportClosedError("Running host frame exceeds limit")
        connection = http.client.HTTPConnection("127.0.0.1", endpoint["port"],
                                                timeout=timeout_seconds or config.request_timeout_seconds)
        connection.request("POST", "/rpc", body=payload, headers={"Content-Type": "application/json",
                            "Authorization": credential, "X-Rpc-Epoch": endpoint["processEpoch"], "Connection": "close"})
        response = connection.getresponse()
        if response.status != 200:
            raise TransportClosedError("Running host request refused")
        data = response.read(config.max_frame_bytes + 1)
        if len(data) > config.max_frame_bytes:
            raise TransportClosedError("Running host response exceeds limit")
        result = json.loads(data)
        if (not isinstance(result, dict) or result.get("version") != "host-admin/v1"
                or result.get("requestId") != request_id or result.get("method") != "sdk.invoke"
                or not isinstance(result.get("result"), dict)):
            raise TransportClosedError("Running host response rejected")
        outcome = result["result"]
        if outcome.get("status") == "ok" and "value" in outcome:
            return outcome["value"]
        code = outcome.get("code")
        if outcome.get("status") == "rejected" and code in ("method-unavailable", "unauthorized", "invalid-params", "unavailable"):
            raise JsonRpcError(-32601 if code == "method-unavailable" else -32603,
                               "Running host request rejected", {"reason": code})
        raise TransportClosedError("Running host response rejected")
    except (JsonRpcError, TransportClosedError):
        raise
    except Exception:
        raise TransportClosedError("Running host outcome unavailable; verify host availability and private files") from None
    finally:
        if connection is not None:
            connection.close()
