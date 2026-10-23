from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator, TypeAlias, TypeVar

from pydantic import BaseModel, TypeAdapter, ValidationError

from . import models as message_models

from .errors import JsonRpcError, SdkProtocolError, TransportClosedError
from .models import IncomingRequest, InitializeExecutionPolicy, InitializeLedgerContext, InitializeResponse, JsonObject, JsonValue, LlmCacheControl, Notification

ModelT = TypeVar("ModelT", bound=BaseModel)
NotificationFilter: TypeAlias = Callable[[Notification], bool]


@dataclass(slots=True)
class HarnessConfig:
    """Configuration for launching the local DeepSeek Harness SDK runtime."""

    dsh_bin: str | None = None
    profile: str = "sdk"
    patches: tuple[str, ...] = ()
    dsh_home: str | None = None
    cwd: str | None = None
    env: dict[str, str] | None = None
    initialize_timeout_seconds: float = 30.0
    request_timeout_seconds: float | None = None
    shutdown_timeout_seconds: float | None = 1.0
    enable_messages: bool = False


class HarnessClient:
    """Synchronous JSON-RPC client for the DeepSeek Harness SDK runtime over stdio."""

    def __init__(
        self,
        config: HarnessConfig | None = None,
        *,
        _launch_args: tuple[str, ...] | None = None,
    ) -> None:
        self.config = config or HarnessConfig()
        self._launch_args = _launch_args
        self._proc: subprocess.Popen[str] | None = None
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._responses: dict[str, queue.Queue[JsonValue | BaseException]] = {}
        self._notifications: queue.Queue[Notification | BaseException] = queue.Queue()
        self._notification_subscribers: dict[
            str, tuple[queue.Queue[Notification | BaseException], NotificationFilter | None]
        ] = {}
        self._session_parents: dict[str, str] = {}
        self._requests: queue.Queue[IncomingRequest | BaseException] = queue.Queue()
        self._stderr_lines: deque[str] = deque(maxlen=400)
        self._reader_thread: threading.Thread | None = None
        self._stderr_thread: threading.Thread | None = None
        self._messages_version: int | None = None
        self.messages = MessagesClient(self)
        self.seats = SeatsClient(self)

    def __enter__(self) -> "HarnessClient":
        self.start()
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        self.close()

    def start(self) -> None:
        if self._proc is not None:
            return
        with self._lock:
            self._session_parents.clear()
        env = os.environ.copy()
        if self.config.env:
            env.update(self.config.env)
        args = list(self._launch_args or self._default_launch_args(env))
        self._proc = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            cwd=None if self.config.cwd is None else str(Path(self.config.cwd).resolve()),
            env=env,
            bufsize=1,
        )
        self._start_reader_thread()
        self._start_stderr_thread()

    def close(self) -> None:
        """Close the runtime after a bounded opportunity to flush durable state."""
        self._messages_version = None
        proc = self._proc
        if proc is None:
            return
        shutdown_completed = False
        try:
            self.request("shutdown", None, response_model=_EmptyResponse, timeout_seconds=self.config.shutdown_timeout_seconds)
            shutdown_completed = True
        except Exception as exc:
            self._stderr_lines.append(f"shutdown request failed: {exc}")
        if proc.stdin:
            try:
                proc.stdin.close()
            except Exception as exc:
                self._stderr_lines.append(f"stdin close failed: {exc}")
        if shutdown_completed:
            try:
                proc.wait(timeout=self.config.shutdown_timeout_seconds)
            except subprocess.TimeoutExpired:
                pass
        if proc.poll() is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
        if proc.poll() is None:
            try:
                proc.wait(timeout=self.config.shutdown_timeout_seconds)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        self._proc = None
        self._fail_waiters(self._runtime_closed_error("Panedesk runtime closed"))
        if self._reader_thread and self._reader_thread.is_alive():
            self._reader_thread.join(timeout=0.5)
        if self._stderr_thread and self._stderr_thread.is_alive():
            self._stderr_thread.join(timeout=0.5)

    def initialize(
        self,
        *,
        cwd: str,
        provider: str,
        model: str,
        reasoning_effort: str | None = None,
        max_tokens: int | None = None,
        agent_preset: str | None = None,
        execution_policy: InitializeExecutionPolicy | None = None,
        ledger_context: InitializeLedgerContext | None = None,
        cache_policy: LlmCacheControl | None = None,
    ) -> InitializeResponse:
        self._messages_version = None
        payload: JsonObject = {
            "cwd": str(Path(cwd).resolve()),
            "provider": provider,
            "model": model,
        }
        if self.config.enable_messages:
            payload["messagesVersion"] = 1
        if reasoning_effort is not None:
            payload["reasoningEffort"] = reasoning_effort
        if max_tokens is not None:
            payload["maxTokens"] = max_tokens
        if agent_preset is not None:
            payload["agentPreset"] = agent_preset
        for key, value in (
            ("executionPolicy", execution_policy),
            ("ledgerContext", ledger_context),
            ("cachePolicy", cache_policy),
        ):
            if value is not None:
                payload[key] = value.model_dump(mode="json", exclude_none=True)
        try:
            response = self.request(
                "initialize",
                payload,
                response_model=InitializeResponse,
                timeout_seconds=self.config.initialize_timeout_seconds,
            )
            self._messages_version = 1 if self.config.enable_messages and response.messagesVersion == 1 else None
            return response
        except TimeoutError as error:
            self.close()
            raise TimeoutError(f"{error}\nselected panedesk profile {self.config.profile!r}") from error
        except BaseException as error:
            self.close()
            diagnostics = self._runtime_diagnostics()
            if isinstance(error, JsonRpcError) and diagnostics:
                raise JsonRpcError(
                    error.code,
                    f"{error.message}\n{diagnostics}",
                    error.data,
                ) from error
            raise

    def session_prompt(
        self,
        session_id: str,
        content_blocks: list[JsonObject],
        *,
        on_notification: Callable[[Notification], None] | None = None,
        notification_subscription: "NotificationSubscription | None" = None,
    ) -> str:
        payload: JsonObject = {"sessionId": session_id, "contentBlocks": content_blocks}
        response = self.request(
            "session/prompt",
            payload,
            response_model=_SessionPromptResponse,
            on_notification=on_notification,
            notification_filter=self._notification_belongs_to_session_tree(session_id),
            notification_subscription=notification_subscription,
        )
        return response.messageId

    def resume_session(self, session_id: str) -> None:
        """Restore a persisted session without sending a prompt; propagate restoration failures."""
        self.request(
            "session/resume",
            {"sessionId": session_id},
            response_model=_EmptyResponse,
        )

    def get_working_directory(self, session_id: str) -> str:
        """Read the effective directory, recovering a missing directory to the Session origin."""
        response = self.request(
            "session/working-directory/get",
            {"sessionId": session_id},
            response_model=_WorkingDirectoryResponse,
        )
        return response.cwd

    def set_working_directory(self, session_id: str, path: str) -> str:
        """Enter an absolute or Session-relative directory without changing origin or permissions."""
        response = self.request(
            "session/working-directory/set",
            {"sessionId": session_id, "path": path},
            response_model=_WorkingDirectoryResponse,
        )
        return response.cwd

    def request(
        self,
        method: str,
        params: JsonObject | None,
        *,
        response_model: type[ModelT],
        timeout_seconds: float | None = None,
        on_notification: Callable[[Notification], None] | None = None,
        notification_filter: NotificationFilter | None = None,
        notification_subscription: "NotificationSubscription | None" = None,
    ) -> ModelT:
        result = self._request_raw(
            method,
            params,
            timeout_seconds=timeout_seconds,
            on_notification=on_notification,
            notification_filter=notification_filter,
            notification_subscription=notification_subscription,
        )
        if not isinstance(result, dict):
            raise TypeError(f"{method} response must be a JSON object")
        return response_model.model_validate(result)

    def notify(self, method: str, params: JsonObject | None = None) -> None:
        message: JsonObject = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        self._write_message(message)

    def next_notification(self) -> Notification:
        item = self._notifications.get()
        if isinstance(item, BaseException):
            raise item
        return item

    def subscribe_notifications(
        self,
        notification_filter: NotificationFilter | None = None,
    ) -> "NotificationSubscription":
        subscription_id = str(uuid.uuid4())
        notifications: queue.Queue[Notification | BaseException] = queue.Queue()
        with self._lock:
            self._notification_subscribers[subscription_id] = (notifications, notification_filter)
        return NotificationSubscription(self, subscription_id, notifications)

    def subscribe_session_notifications(self, session_id: str) -> "NotificationSubscription":
        """Subscribe to a session and descendants discovered from subagent lifecycle edges."""
        return self.subscribe_notifications(self._notification_belongs_to_session_tree(session_id))

    def next_request(self) -> IncomingRequest:
        item = self._requests.get()
        if isinstance(item, BaseException):
            raise item
        return item

    def respond(self, request_id: str | int, result: JsonValue) -> None:
        self._write_message({"jsonrpc": "2.0", "id": request_id, "result": result})

    def respond_error(
        self,
        request_id: str | int,
        *,
        code: int,
        message: str,
        data: JsonValue | None = None,
    ) -> None:
        error: JsonObject = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        self._write_message({"jsonrpc": "2.0", "id": request_id, "error": error})

    def _request_raw(
        self,
        method: str,
        params: JsonObject | None = None,
        *,
        timeout_seconds: float | None = None,
        on_notification: Callable[[Notification], None] | None = None,
        notification_filter: NotificationFilter | None = None,
        notification_subscription: "NotificationSubscription | None" = None,
    ) -> JsonValue:
        request_id = str(uuid.uuid4())
        waiter: queue.Queue[JsonValue | BaseException] = queue.Queue(maxsize=1)
        temp_subscription: NotificationSubscription | None = None
        subscription = notification_subscription
        with self._lock:
            self._responses[request_id] = waiter
        if on_notification is not None and subscription is None:
            temp_subscription = self.subscribe_notifications(notification_filter)
            subscription = temp_subscription
        try:
            message: JsonObject = {"jsonrpc": "2.0", "id": request_id, "method": method}
            if params is not None:
                message["params"] = params
            self._write_message(message)
        except BaseException:
            with self._lock:
                self._responses.pop(request_id, None)
            if temp_subscription is not None:
                temp_subscription.close()
            raise
        timeout = self.config.request_timeout_seconds if timeout_seconds is None else timeout_seconds
        deadline = None if timeout is None else time.monotonic() + timeout
        try:
            while True:
                if on_notification is not None and subscription is not None:
                    subscription.drain(on_notification)
                wait_timeout = None
                if on_notification is not None:
                    wait_timeout = 0.05
                if deadline is not None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        with self._lock:
                            self._responses.pop(request_id, None)
                        diagnostics = self._runtime_diagnostics()
                        suffix = f"\n{diagnostics}" if diagnostics else ""
                        raise TimeoutError(
                            f"{method} timed out waiting for Panedesk runtime{suffix}"
                        )
                    wait_timeout = remaining if wait_timeout is None else min(wait_timeout, remaining)
                try:
                    item = waiter.get(timeout=wait_timeout)
                    if on_notification is not None and subscription is not None:
                        subscription.drain(on_notification)
                    break
                except queue.Empty:
                    continue
        except BaseException:
            with self._lock:
                self._responses.pop(request_id, None)
            if temp_subscription is not None:
                temp_subscription.close()
            raise
        finally:
            if temp_subscription is not None:
                temp_subscription.close()
        if isinstance(item, BaseException):
            raise item
        return item

    def _write_message(self, message: JsonObject) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None:
            raise TransportClosedError("Panedesk runtime is not running")
        try:
            payload = json.dumps(message, separators=(",", ":")) + "\n"
            with self._write_lock:
                proc.stdin.write(payload)
                proc.stdin.flush()
        except Exception as exc:
            raise self._runtime_closed_error("Failed to write to Panedesk runtime") from exc

    def _start_reader_thread(self) -> None:
        self._reader_thread = threading.Thread(target=self._reader_loop, name="dsh-runtime-reader", daemon=True)
        self._reader_thread.start()

    def _start_stderr_thread(self) -> None:
        self._stderr_thread = threading.Thread(target=self._stderr_loop, name="dsh-runtime-stderr", daemon=True)
        self._stderr_thread.start()

    def _reader_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        try:
            for line in proc.stdout:
                if not line.strip():
                    continue
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue
                self._handle_message(message)
        except BaseException as exc:
            self._fail_waiters(exc)
        finally:
            self._fail_waiters(self._runtime_closed_error("Panedesk runtime stdout closed"))

    def _stderr_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        for line in proc.stderr:
            self._stderr_lines.append(line.rstrip())

    def _handle_message(self, message: object) -> None:
        if not isinstance(message, dict):
            return
        msg_id = message.get("id")
        method = message.get("method")
        if isinstance(msg_id, (str, int)) and isinstance(method, str):
            params = message.get("params")
            self._requests.put(IncomingRequest(id=msg_id, method=method, payload=params if isinstance(params, dict) else {}))
            return
        if isinstance(msg_id, (str, int)):
            with self._lock:
                waiter = self._responses.pop(str(msg_id), None)
            if waiter is None:
                return
            if isinstance(message.get("error"), dict):
                err = message["error"]
                waiter.put(JsonRpcError(_int_or_none(err.get("code")), str(err.get("message", "JSON-RPC error")), err.get("data")))
            else:
                waiter.put(message.get("result"))
            return
        if isinstance(method, str):
            params = message.get("params")
            notification = Notification(method=method, payload=params if isinstance(params, dict) else {})
            with self._lock:
                self._record_session_relationship_locked(notification)
                subscribers = list(self._notification_subscribers.items())
            delivered = False
            for subscription_id, (subscriber, predicate) in subscribers:
                try:
                    matches = predicate is None or predicate(notification)
                except BaseException as exc:
                    with self._lock:
                        current = self._notification_subscribers.get(subscription_id)
                        if current is not None and current[0] is subscriber:
                            self._notification_subscribers.pop(subscription_id, None)
                    subscriber.put(exc)
                    continue
                if matches:
                    subscriber.put(notification)
                    delivered = True
            if not delivered:
                self._notifications.put(notification)

    def _fail_waiters(self, exc: BaseException) -> None:
        with self._lock:
            waiters = list(self._responses.values())
            self._responses.clear()
            subscribers = list(self._notification_subscribers.values())
            self._notification_subscribers.clear()
        for waiter in waiters:
            waiter.put(exc)
        for subscriber, _predicate in subscribers:
            subscriber.put(exc)
        self._notifications.put(exc)
        self._requests.put(exc)

    def _runtime_closed_error(self, reason: str) -> TransportClosedError:
        diagnostics = self._runtime_diagnostics()
        return TransportClosedError(f"{reason}\n{diagnostics}" if diagnostics else reason)

    def _runtime_diagnostics(self) -> str:
        """Return available subprocess state for transport failures and timeouts."""
        proc = self._proc
        if (
            proc is not None
            and proc.poll() is not None
            and self._stderr_thread is not None
            and self._stderr_thread.is_alive()
            and threading.current_thread() is not self._stderr_thread
        ):
            self._stderr_thread.join(timeout=0.1)

        parts: list[str] = []
        if proc is not None:
            exit_code = proc.poll()
            if exit_code is not None:
                parts.append(f"exit code: {exit_code}")
        if self._stderr_lines:
            parts.append("stderr tail:\n" + "\n".join(self._stderr_lines))
        return "\n".join(parts)

    def _default_launch_args(self, env: dict[str, str]) -> tuple[str, ...]:
        if self.config.dsh_bin is None:
            try:
                from deepseek_harness_runtime import resolve_bundled_launch_args
            except ImportError as exc:
                raise FileNotFoundError(
                    "Unable to locate the bundled Panedesk dsh runtime. "
                    "Install deepseek-harness-runtime-bin."
                ) from exc
            base = resolve_bundled_launch_args()
        else:
            base = (str(Path(self.config.dsh_bin).expanduser().resolve()),)

        if self.config.dsh_home is not None:
            if not self.config.dsh_home.strip():
                raise ValueError("HarnessConfig requires a non-empty dsh_home")
            env["PANEDESK_HOME"] = str(Path(self.config.dsh_home).expanduser().resolve())
        elif not env.get("PANEDESK_HOME", "").strip():
            raise ValueError(
                "HarnessConfig requires an explicit dsh_home or non-empty PANEDESK_HOME; "
                "the Python SDK never uses ~/.panedesk implicitly"
            )

        patches = tuple(
            argument
            for patch in self.config.patches
            for argument in ("--patch", str(Path(patch).expanduser().resolve()))
        )
        return (*base, "--profile", self.config.profile, *patches)

    def _unsubscribe_notifications(self, subscription_id: str) -> None:
        with self._lock:
            self._notification_subscribers.pop(subscription_id, None)

    def _record_session_relationship_locked(self, notification: Notification) -> None:
        if notification.method != "subagent.started":
            return
        parent_id = notification.payload.get("parentSessionId")
        child_id = notification.payload.get("childSessionId")
        if (
            isinstance(parent_id, str)
            and parent_id
            and isinstance(child_id, str)
            and child_id
            and parent_id != child_id
        ):
            self._session_parents[child_id] = parent_id

    def _notification_belongs_to_session_tree(self, session_id: str) -> NotificationFilter:
        def belongs(notification: Notification) -> bool:
            payload = notification.payload
            if notification.method in {"subagent.started", "subagent.finished"}:
                parent_id = payload.get("parentSessionId")
                if (
                    isinstance(parent_id, str)
                    and self._session_is_descendant_of(parent_id, session_id)
                ):
                    return True
                return payload.get("childSessionId") == session_id
            related_id = payload.get("sessionId")
            return (
                isinstance(related_id, str)
                and self._session_is_descendant_of(related_id, session_id)
            )

        return belongs

    def _session_is_descendant_of(self, session_id: str, root_session_id: str) -> bool:
        current = session_id
        visited: set[str] = set()
        while current not in visited:
            if current == root_session_id:
                return True
            visited.add(current)
            parent = self._session_parents.get(current)
            if parent is None:
                return False
            current = parent
        return False


class SeatsClient:
    """Node-local seat operations; never fall back to ordinary prompts on failure."""

    def __init__(self, client: HarnessClient, *, _before_request: Callable[[], None] | None = None) -> None:
        self._client = client
        self._before_request = _before_request

    def _call(self, method: str, request: BaseModel | JsonObject, model: type[BaseModel] | None = None) -> JsonObject | None:
        payload = request.model_dump(mode="json", exclude_none=True) if isinstance(request, BaseModel) else dict(request)
        if model is not None:
            payload = model.model_validate(payload).model_dump(mode="json", exclude_none=True)
        if method in ("open", "openBatch"):
            payload.update(origin="remote", openingMode="auto")
        if self._before_request is not None:
            self._before_request()
        if method == "operation" and "nodeId" in payload:
            raise ValueError("operation lookup accepts only operationId")
        result = self._client._request_raw("seats/" + method, payload)
        if method == "binding" and result is None:
            return None
        if not isinstance(result, dict):
            raise SdkProtocolError("Invalid seats/" + method + " result")
        try:
            message_models.validate_seat_result(method, result)
            if method in ("import.preview", "import.commit", "setAuthority", "report.submit", "wait.register", "wait.cancel"):
                return result
            if "status" in result:
                message_models.SeatResult.model_validate(result)
                variants = {
                    "list": ("listed",), "open": ("opened", "prefilled", "choice-required", "switched", "cancelled", "queued"),
                    "openBatch": ("processed",), "renew": ("renewed", "uncertain"), "close": ("closed", "busy", "conflict"),
                    "replace": ("queued", "replacing", "failed"), "rename": ("renamed",),
                    "wake": ("sent", "stored-budget-stopped", "opened", "choice-required"),
                    "operation": ("missing", "pending", "settled"), "setProjectMode": ("saved",),
                    "approve": ("approved",), "cancel": ("cancelled",),
                }
                if result["status"] != "rejected" and result["status"] not in variants.get(method, ()):
                    raise ValueError("unexpected seat outcome")
                if method == "open" and result["status"] == "queued" and not isinstance(result.get("blockedBy"), list):
                    raise ValueError("missing queue blockers")
                if method == "open" and result["status"] == "opened" and "sessionId" not in result:
                    raise ValueError("missing opened session")
            elif method == "binding":
                if not result.get("sessionId") or not result.get("nodeId") or result.get("kind") not in ("free", "seat"):
                    raise ValueError("invalid binding")
                if result["kind"] == "free" and result.get("identitySource") != "free":
                    raise ValueError("invalid free binding")
            elif method == "nodeStatus":
                if any(key not in result for key in ("nodeId", "nodeName", "engine", "openEngineWindows", "limit")):
                    raise ValueError("incomplete node status")
            elif method in ("pending", "gates"):
                key = "items" if method == "pending" else "gates"
                if not isinstance(result.get(key), list) or type(result.get("complete")) is not bool or type(result.get("watermark")) is not int:
                    raise ValueError("invalid result page")
            else:
                raise ValueError("missing status")
        except (ValidationError, ValueError) as error:
            raise SdkProtocolError("Invalid seats/" + method + " result") from error
        return result

    def list(self, request: message_models.ListSeatsRequest | JsonObject | None = None) -> JsonObject | None:
        """List runtime states and unopened seats, preserving incomplete evidence."""
        return self._call("list", request or {}, message_models.ListSeatsRequest)

    def open(self, request: message_models.OpenSeatRequest | JsonObject) -> JsonObject | None:
        """Open an exact definition with automatic remote opening."""
        return self._call("open", request, message_models.OpenSeatRequest)

    def open_batch(self, request: message_models.OpenSeatBatchRequest | JsonObject) -> JsonObject | None:
        """Open only explicit unique names and return independent outcomes."""
        return self._call("openBatch", request, message_models.OpenSeatBatchRequest)

    def renew(self, request: message_models.SeatSessionRequest | JsonObject) -> JsonObject | None:
        """Request one maintenance call without conversation text."""
        return self._call("renew", request, message_models.SeatSessionRequest)

    def close(self, request: message_models.CloseSeatRequest | JsonObject) -> JsonObject | None:
        """Close at the observed state version, never force-stop busy work."""
        return self._call("close", request, message_models.CloseSeatRequest)

    def replace(self, request: message_models.SeatSessionRequest | JsonObject) -> JsonObject | None:
        """Open new before closing old; retain operation identity across uncertainty."""
        return self._call("replace", request, message_models.SeatSessionRequest)

    def rename(self, request: message_models.RenameSeatRequest | JsonObject) -> JsonObject | None:
        """Preserve upstream pinned-title semantics."""
        return self._call("rename", request, message_models.RenameSeatRequest)

    def wake(self, request: message_models.WakeSeatRequest | JsonObject) -> JsonObject | None:
        """Send the definition's wake text or open an unopened seat."""
        return self._call("wake", request, message_models.WakeSeatRequest)

    def operation(self, request: message_models.SeatOperationRequest | JsonObject) -> JsonObject | None:
        """Observe a durable operation instead of replaying side effects."""
        return self._call("operation", request, message_models.SeatOperationRequest)

    def binding(self, request: message_models.SeatBindingRequest | JsonObject) -> JsonObject | None:
        """Read the Session's engine metadata without changing its log."""
        return self._call("binding", request, message_models.SeatBindingRequest)

    def preview_import(self, request: message_models.PreviewSeatImportRequest | JsonObject) -> JsonObject | None:
        """Preview explicit source rows without catalog mutation."""
        return self._call("import.preview", request, message_models.PreviewSeatImportRequest)

    def commit_import(self, request: message_models.CommitSeatImportRequest | JsonObject) -> JsonObject | None:
        """Commit only selected preview rows at the observed revision."""
        return self._call("import.commit", request, message_models.CommitSeatImportRequest)

    def set_authority(self, request: message_models.SetSeatAuthorityRequest | JsonObject) -> JsonObject | None:
        """Transfer editing authority with independent authorization."""
        return self._call("setAuthority", request, message_models.SetSeatAuthorityRequest)

    def submit_report(self, request: message_models.SubmitCloseReportRequest | JsonObject) -> JsonObject | None:
        """Record a report without claiming that the window is idle."""
        return self._call("report.submit", request, message_models.SubmitCloseReportRequest)

    def register_wait(self, request: message_models.RegisterSeatWaitRequest | JsonObject) -> JsonObject | None:
        """Register observations without awaiting task completion."""
        return self._call("wait.register", request, message_models.RegisterSeatWaitRequest)

    def cancel_wait(self, request: message_models.CancelSeatWaitRequest | JsonObject) -> JsonObject | None:
        """Cancel observation without cancelling underlying tasks."""
        return self._call("wait.cancel", request, message_models.CancelSeatWaitRequest)

    def node_status(self) -> JsonObject | None:
        """Read the configured node alias and local capacity."""
        return self._call("nodeStatus", {})

    def pending(self, request: message_models.PendingSeatsRequest | JsonObject) -> JsonObject | None:
        """Read pending work at its committed watermark."""
        return self._call("pending", request, message_models.PendingSeatsRequest)

    def gates(self, request: message_models.SeatGatesRequest | JsonObject) -> JsonObject | None:
        """Read committed gate counts and expiration evidence."""
        return self._call("gates", request, message_models.SeatGatesRequest)

    def set_project_mode(self, request: message_models.SetSeatProjectModeRequest | JsonObject) -> JsonObject | None:
        """Select project policy with revision comparison."""
        return self._call("setProjectMode", request, message_models.SetSeatProjectModeRequest)

    def approve(self, request: message_models.PendingSeatMutationRequest | JsonObject) -> JsonObject | None:
        """Approve reminder confirmation without bypassing admission."""
        return self._call("approve", request, message_models.PendingSeatMutationRequest)

    def cancel(self, request: message_models.PendingSeatMutationRequest | JsonObject) -> JsonObject | None:
        """Cancel unopened work without closing windows."""
        return self._call("cancel", request, message_models.PendingSeatMutationRequest)


MessageResultT = TypeVar("MessageResultT")


class MessagesClient:
    """Typed message requests; unavailable extensions fail without falling back to prompt.

    Request models and dictionaries use the wire's camelCase fields. RPC failures
    retain their code/data; invalid results raise SdkProtocolError. Transport
    failures do not imply that a durable operation was rolled back. Retain the
    operationId when resolving an uncertain outcome with operation_status.
    """

    def __init__(
        self,
        client: HarnessClient,
        *,
        _before_request: Callable[[], None] | None = None,
        _session_id: str | None = None,
    ) -> None:
        self._client = client
        self._before_request = _before_request
        self._session_id = _session_id

    def _prepare(self) -> None:
        if self._before_request is not None:
            self._before_request()
        if not self._client.config.enable_messages:
            raise JsonRpcError(-32601, "Message delivery capability was not negotiated", {"reason": "unsupported"})
        if self._client._messages_version != 1:
            raise JsonRpcError(-32601, "Message delivery is unsupported by the runtime", {"reason": "unsupported"})

    def _payload(self, request: BaseModel | JsonObject) -> JsonObject:
        if isinstance(request, BaseModel):
            return request.model_dump(mode="json", by_alias=True, exclude_none=True)
        return dict(request)

    def _session_payload(self, request: BaseModel | JsonObject | None) -> JsonObject:
        payload = self._payload(request) if request is not None else {}
        if self._session_id is not None:
            payload.setdefault("sessionId", self._session_id)
        return payload

    def _send_payload(self, request: BaseModel | JsonObject, *, batch: bool = False) -> JsonObject:
        payload = self._payload(request)
        if not batch and self._session_id is not None:
            payload.setdefault("target", {"sessionId": self._session_id})
        payload.setdefault("priority", "queue" if payload.get("messageClass") == "notice" else "steer")
        return payload

    def _request(
        self,
        method: str,
        params: JsonObject,
        request_model: type[BaseModel],
        result_adapter: TypeAdapter[MessageResultT],
    ) -> MessageResultT:
        self._prepare()
        request = request_model.model_validate(params)
        result = self._client._request_raw(
            method, request.model_dump(mode="json", by_alias=True, exclude_none=True),
        )
        try:
            return result_adapter.validate_python(result)
        except ValidationError as error:
            raise SdkProtocolError(f"Invalid {method} result") from error

    def send(self, request: message_models.SendMessageRequest | JsonObject) -> message_models.SendMessageResult:
        """Send with steer by default, or passive queue for notices; preserve explicit priority."""
        return self._request("messages/send", self._send_payload(request), message_models.SendMessageRequest,
                             TypeAdapter(message_models.SendMessageResult))

    def withdraw(self, request: message_models.MessageControlRequest | JsonObject) -> message_models.ControlResult:
        """Submit withdrawal; pending-owner is durable intent, not confirmed removal."""
        return self._request("messages/withdraw", self._payload(request), message_models.MessageControlRequest,
                             TypeAdapter(message_models.ControlResult))

    def edit(self, request: message_models.EditMessageRequest | JsonObject) -> message_models.ControlResult:
        """Replace queued text without changing message identity."""
        return self._request("messages/edit", self._payload(request), message_models.EditMessageRequest,
                             TypeAdapter(message_models.ControlResult))

    def reprioritize(self, request: message_models.ReprioritizeMessageRequest | JsonObject) -> message_models.ControlResult:
        """Request an explicit priority change; the target owner decides eligibility."""
        return self._request("messages/reprioritize", self._payload(request), message_models.ReprioritizeMessageRequest,
                             TypeAdapter(message_models.ControlResult))

    def invalidate(self, request: message_models.InvalidateMessageRequest | JsonObject) -> message_models.ControlResult:
        """Invalidate injected input without deleting history; queued input is withdrawn."""
        return self._request("messages/invalidate", self._payload(request), message_models.InvalidateMessageRequest,
                             TypeAdapter(message_models.ControlResult))

    def status(self, message_id: str) -> message_models.MessageStatus:
        """Read runtime-owned state, phase and retained transition times."""
        return self._request("messages/status", {"messageId": message_id}, _MessageStatusRequest,
                             TypeAdapter(message_models.MessageStatus))

    def operation_status(self, operation_id: str) -> message_models.OperationStatus:
        """Distinguish unknown, pending, applied and rejected durable operations."""
        return self._request("messages/operationStatus", {"operationId": operation_id}, _MessageOperationRequest,
                             TypeAdapter(message_models.OperationStatus))

    def list(self, query: message_models.MessageQuery | JsonObject | None = None) -> message_models.MessagePage:
        """Query receipts; a Session facade defaults sessionId to itself."""
        return self._request("messages/list", self._session_payload(query), message_models.MessageQuery,
                             TypeAdapter(message_models.MessagePage))

    def resolve(self, addresses: list[message_models.MessageAddress] | list[JsonObject]) -> list[message_models.ResolvedRecipient]:
        """Resolve only the explicit addresses without opening or delivering to Sessions."""
        params: JsonObject = {"addresses": [self._payload(address) for address in addresses]}
        return self._request("messages/resolve", params, _MessageResolveRequest,
                             TypeAdapter(list[message_models.ResolvedRecipient]))

    def send_batch(self, request: message_models.SendBatchRequest | JsonObject) -> message_models.SendBatchResult:
        """Resolve a dry run or send independently to each explicit recipient."""
        return self._request("messages/sendBatch", self._send_payload(request, batch=True), message_models.SendBatchRequest,
                             TypeAdapter(message_models.SendBatchResult))

    def configure(self, request: message_models.ConfigureMessagesRequest | JsonObject) -> message_models.MessageSettings:
        """Replace the complete policy; a Session facade defaults sessionId to itself."""
        return self._request("messages/configure", self._session_payload(request), message_models.ConfigureMessagesRequest,
                             TypeAdapter(message_models.MessageSettings))

    def subscribe(self, request: message_models.MessageSubscriptionRequest | JsonObject | None = None) -> "MessageSubscription":
        """Subscribe before admission to retain early receipts; close the returned stream.

        Pass its cursor to a new subscription after disconnection. Only local
        reception closes: this wire version has no unsubscribe method. The
        runtime replaces the previous stream when subscribing to the same Session.
        """
        self._prepare()
        params = message_models.MessageSubscriptionRequest.model_validate(self._session_payload(request))
        subscription = MessageSubscription(self._client, params)
        try:
            self._request("messages/subscribe", self._payload(params), message_models.MessageSubscriptionRequest,
                          TypeAdapter(message_models.MessagesSubscribeResult))
        except BaseException:
            subscription.close()
            raise
        return subscription


class MessageSubscription(Iterator[message_models.MessageStateEvent]):
    """Synchronous receipt stream; cursor advances only for validated delivered events.

    Closing unblocks a pending next call. Stream errors retain the last cursor in
    JsonRpcError.data, while transport failures propagate without automatic retry.
    """

    def __init__(self, client: HarnessClient, request: message_models.MessageSubscriptionRequest) -> None:
        self.cursor = request.cursor
        self._session_id = request.sessionId
        self._closed = False
        self._subscription = client.subscribe_notifications(self._matches)

    def _matches(self, notification: Notification) -> bool:
        try:
            if notification.method == "messages.error":
                error = message_models.MessageStreamError.model_validate(notification.payload)
                return error.sessionId == self._session_id
            if notification.method != "messages.state":
                return False
            event = message_models.MessageStateEvent.model_validate(notification.payload)
            return self._session_id in (event.data.senderSessionId, event.data.targetSessionId)
        except ValidationError as error:
            raise SdkProtocolError(f"Invalid {notification.method} notification") from error

    def __enter__(self) -> "MessageSubscription":
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        self.close()

    def __next__(self) -> message_models.MessageStateEvent:
        return self.next()

    def next(self) -> message_models.MessageStateEvent:
        """Wait for a new receipt; duplicate current cursors do not advance the stream."""
        while not self._closed:
            try:
                notification = self._subscription.next()
                if self._closed:
                    break
                if notification.method == "messages.error":
                    raise JsonRpcError(-32603, "Message receipt stream is unavailable",
                                       {"reason": "unavailable", "cursor": self.cursor})
                event = message_models.MessageStateEvent.model_validate(notification.payload)
                if event.cursor == self.cursor:
                    continue
                self.cursor = event.cursor
                return event
            except BaseException:
                self.close()
                raise
        raise StopIteration

    def close(self) -> None:
        """Stop local delivery without sending an unsupported unsubscribe request."""
        if self._closed:
            return
        self._closed = True
        self._subscription.close()
        self._subscription._notifications.put(Notification(method="messages.closed", payload={}))


class _MessageStatusRequest(message_models._MessageModel):
    messageId: message_models._MessageText


class _MessageOperationRequest(message_models._MessageModel):
    operationId: message_models._MessageText


class _MessageResolveRequest(message_models._MessageModel):
    addresses: list[message_models.MessageAddress]


class NotificationSubscription:
    def __init__(
        self,
        client: HarnessClient,
        subscription_id: str,
        notifications: queue.Queue[Notification | BaseException],
    ) -> None:
        self._client = client
        self._subscription_id = subscription_id
        self._notifications = notifications
        self._closed = False

    def __enter__(self) -> "NotificationSubscription":
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        self.close()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._client._unsubscribe_notifications(self._subscription_id)

    def next(self) -> Notification:
        item = self._notifications.get()
        if isinstance(item, BaseException):
            raise item
        return item

    def drain(self, on_notification: Callable[[Notification], None]) -> None:
        while True:
            try:
                item = self._notifications.get_nowait()
            except queue.Empty:
                return
            if isinstance(item, BaseException):
                raise item
            on_notification(item)


class _SessionPromptResponse(BaseModel):
    messageId: str


class _WorkingDirectoryResponse(BaseModel):
    cwd: str


class _EmptyResponse(BaseModel):
    pass


def _int_or_none(value: object) -> int | None:
    return value if isinstance(value, int) else None
