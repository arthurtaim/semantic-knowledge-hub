"""Claude Code CLI as an isolated subprocess (`claude -p --output-format stream-json`).

Security model (docs/CLAUDE_CODE_CLI_INTEGRATION.md §6):
- exec without a shell: argv is a list, the prompt goes through stdin (never through argv or a shell);
- all built-in tools disabled (`--tools ""`), `--restricted` (no code-running tools, no WebFetch, user/project/
  local settings ignored, so no hooks), no MCP servers (`--strict-mcp-config` + empty config), no slash
  commands, no session persistence, `--permission-mode dontAsk` (anything not pre-approved is denied);
- an empty, private working directory per request, removed afterwards; a minimal environment with only the
  variables the CLI needs — the application's secrets are never passed;
- the run is aborted if the CLI reports any tool or MCP server in its `init` event, starts a tool call or
  reports permission denials (defence in depth: none of these may happen with the flags above);
- a hard timeout and cancellation kill the whole process group.

Authorization is the CLI's own: an OAuth token created with the official `claude setup-token` and read from a
file at spawn time (CLAUDE_CODE_OAUTH_TOKEN for the child only), or a login stored in the worker's own
CLAUDE_CONFIG_DIR. The worker never logs or returns the token, prompts, model output or the CLI's stderr.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import shutil
import signal
import tempfile
import time
from collections.abc import AsyncGenerator, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import anyio

logger = logging.getLogger("skh.claude_worker")

# Flags that make the CLI a pure text model for this worker. Verified against Claude Code 2.1.318 `--help`.
SAFETY_ARGS: tuple[str, ...] = (
    "--tools",
    "",
    "--restricted",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
)
STREAM_ARGS: tuple[str, ...] = (
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
)
_TOKEN_RE = re.compile(r"^[A-Za-z0-9._~+/=-]{20,4096}$")
_AUTH_RE = re.compile(
    r"log ?in|logged in|oauth|unauthori[sz]ed|invalid api key|credential|token.*expired", re.I
)
_RATE_RE = re.compile(r"rate.?limit|usage limit|limit reached|overloaded|too many requests", re.I)
_MAX_LINE = 4 * 1024 * 1024
_TEXT_BLOCKS = {"text", "thinking", "redacted_thinking"}


class WorkerError(Exception):
    """A classified failure. `code` is stable and safe to show; `message` never contains CLI output."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class WorkerConfig:
    cli_command: tuple[str, ...] = ("claude",)
    token_file: str = ""  # file with a `claude setup-token` OAuth token; optional
    home_dir: str = "/tmp/claude-home"  # noqa: S108 - private tmpfs in the container
    runs_dir: str = "/tmp/claude-runs"  # noqa: S108
    model: str = ""
    timeout_seconds: float = 120.0
    max_timeout_seconds: float = 300.0
    max_concurrency: int = 1
    max_prompt_chars: int = 200_000
    max_system_chars: int = 20_000
    max_output_chars: int = 200_000

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> WorkerConfig:
        e = os.environ if env is None else env
        command = tuple(e.get("CLAUDE_CLI_COMMAND", "claude").split())
        return cls(
            cli_command=command or ("claude",),
            token_file=e.get("CLAUDE_CODE_OAUTH_TOKEN_FILE", ""),
            home_dir=e.get("CLAUDE_WORKER_HOME", cls.home_dir),
            runs_dir=e.get("CLAUDE_WORKER_RUNS_DIR", cls.runs_dir),
            model=e.get("CLAUDE_CLI_MODEL", ""),
            timeout_seconds=float(e.get("CLAUDE_WORKER_TIMEOUT_SECONDS", "120")),
            max_timeout_seconds=float(e.get("CLAUDE_WORKER_MAX_TIMEOUT_SECONDS", "300")),
            max_concurrency=max(1, int(e.get("CLAUDE_WORKER_MAX_CONCURRENCY", "1"))),
        )


@dataclass
class RunOutcome:
    ok: bool
    code: str | None
    at: str
    duration_ms: int


@dataclass
class _RunState:
    output_chars: int = 0
    assistant_error: str | None = None
    result: dict[str, Any] | None = None
    events: int = 0


def build_argv(config: WorkerConfig, system_prompt: str) -> list[str]:
    argv = [*config.cli_command, *STREAM_ARGS, *SAFETY_ARGS, "--system-prompt", system_prompt]
    if config.model:
        argv += ["--model", config.model]
    return argv


def build_env(config: WorkerConfig, token: str | None) -> dict[str, str]:
    """Only what the CLI needs. Nothing is inherited from the worker's own environment."""
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": config.home_dir,
        "CLAUDE_CONFIG_DIR": str(Path(config.home_dir) / ".claude"),
        "LANG": "C.UTF-8",
        "TMPDIR": config.runs_dir,
        "DISABLE_AUTOUPDATER": "1",
        "DISABLE_TELEMETRY": "1",
        "DISABLE_ERROR_REPORTING": "1",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    }
    if token:
        env["CLAUDE_CODE_OAUTH_TOKEN"] = token
    return env


def classify_failure(assistant_error: str | None, result_text: str, api_status: object) -> WorkerError:
    """Map a CLI failure to a stable code without echoing the CLI's text back."""
    err = (assistant_error or "").lower()
    if err in ("authentication_failed", "oauth_token_expired") or api_status in (401, 403):
        return WorkerError(
            "ai_auth_failed",
            "Авторизация Claude Code отсутствует или истекла. Обновите токен (`claude setup-token`) на сервере.",
        )
    if err == "billing_error":
        return WorkerError("ai_auth_failed", "Подписка Claude недоступна для этой авторизации.")
    if err == "rate_limit" or api_status == 429 or _RATE_RE.search(result_text):
        return WorkerError("ai_rate_limited", "Лимит запросов подписки Claude исчерпан. Повторите позже.")
    if _AUTH_RE.search(result_text):
        return WorkerError(
            "ai_auth_failed",
            "Авторизация Claude Code отсутствует или истекла. Обновите токен (`claude setup-token`) на сервере.",
        )
    return WorkerError("ai_upstream_error", "Claude Code завершил запрос с ошибкой.")


class ClaudeCLIRunner:
    def __init__(self, config: WorkerConfig) -> None:
        self.config = config
        self.active = 0
        self.last_run: RunOutcome | None = None
        self._version: tuple[float, str | None] | None = None
        self._auth_status: tuple[float, dict[str, Any]] | None = None

    # --- concurrency -------------------------------------------------------------------------
    def try_acquire(self) -> bool:
        """Non-blocking slot reservation (single event loop: check-and-increment is atomic)."""
        if self.active >= self.config.max_concurrency:
            return False
        self.active += 1
        return True

    def release(self) -> None:
        self.active = max(0, self.active - 1)

    # --- auth --------------------------------------------------------------------------------
    def read_token(self) -> str | None:
        if not self.config.token_file:
            return None
        try:
            token = Path(self.config.token_file).read_text(encoding="utf-8").strip()
        except OSError:
            return None
        return token if _TOKEN_RE.match(token) else None

    def auth_source(self) -> str:
        if self.read_token():
            return "token_file"
        if (Path(self.config.home_dir) / ".claude" / ".credentials.json").is_file():
            return "config_dir"
        return "none"

    def _prepare_dirs(self) -> None:
        for path in (self.config.home_dir, self.config.runs_dir):
            Path(path).mkdir(parents=True, exist_ok=True)
            with contextlib.suppress(OSError):
                Path(path).chmod(0o700)

    # --- run ---------------------------------------------------------------------------------
    async def run(
        self, system_prompt: str, prompt: str, *, timeout: float | None = None
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Yield {"type": "delta", "text"} events and one final {"type": "result", …}.
        Raises WorkerError. Closing the iterator (or cancelling the consumer) kills the CLI."""
        cfg = self.config
        if not system_prompt.strip() or len(system_prompt) > cfg.max_system_chars:
            raise WorkerError("ai_invalid_request", "Недопустимый системный промпт.")
        if not prompt.strip() or len(prompt) > cfg.max_prompt_chars:
            raise WorkerError("ai_invalid_request", "Запрос пустой или превышает лимит размера.")
        limit = min(timeout or cfg.timeout_seconds, cfg.max_timeout_seconds)
        self._prepare_dirs()
        workdir = tempfile.mkdtemp(prefix="run-", dir=cfg.runs_dir)
        started = time.monotonic()
        outcome_code: str | None = None
        proc: asyncio.subprocess.Process | None = None
        stderr_task: asyncio.Task[int] | None = None
        try:
            try:
                proc = await asyncio.create_subprocess_exec(
                    *build_argv(cfg, system_prompt),
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=workdir,
                    env=build_env(cfg, self.read_token()),
                    start_new_session=True,  # own process group: a kill reaches every child
                    limit=_MAX_LINE,
                )
            except (FileNotFoundError, PermissionError) as exc:
                raise WorkerError("ai_cli_unavailable", "Claude Code CLI не найден в воркере.") from exc
            assert proc.stdin is not None and proc.stdout is not None and proc.stderr is not None
            stderr_task = asyncio.create_task(_drain(proc.stderr))
            try:
                proc.stdin.write(prompt.encode("utf-8"))
                await proc.stdin.drain()
                proc.stdin.close()
            except (BrokenPipeError, ConnectionResetError) as exc:
                raise WorkerError(
                    "ai_cli_unavailable", "Claude Code CLI завершился до получения запроса."
                ) from exc
            state = _RunState()
            # The deadline is enforced on every read (never across a `yield`, where a cancel would hit
            # the consumer instead of this generator).
            deadline = asyncio.get_running_loop().time() + limit
            try:
                async for event in _read_events(proc.stdout, deadline):
                    state.events += 1
                    delta = self._handle(event, state)
                    if delta is not None:
                        yield {"type": "delta", "text": delta}
                returncode = await asyncio.wait_for(proc.wait(), timeout=_remaining(deadline))
            except TimeoutError as exc:
                raise WorkerError("ai_timeout", f"Claude Code не ответил за {int(limit)} с.") from exc
            result = state.result
            if result is None:
                raise WorkerError(
                    "ai_upstream_error", f"Claude Code завершился без результата (код {returncode})."
                )
            if result.get("is_error"):
                raise classify_failure(
                    state.assistant_error, str(result.get("result") or ""), result.get("api_error_status")
                )
            if result.get("permission_denials"):
                raise WorkerError(
                    "ai_tool_use_blocked", "Claude Code пытался использовать инструменты — запрос прерван."
                )
            usage = _dict(result.get("usage"))
            yield {
                "type": "result",
                "text": str(result.get("result") or "")[: cfg.max_output_chars],
                "duration_ms": int(result.get("duration_ms") or (time.monotonic() - started) * 1000),
                "stop_reason": result.get("stop_reason"),
                "usage": {
                    k: usage.get(k)
                    for k in ("input_tokens", "output_tokens", "cache_read_input_tokens")
                    if isinstance(usage.get(k), int)
                },
            }
        except WorkerError as exc:
            outcome_code = exc.code
            raise
        except (asyncio.CancelledError, GeneratorExit):
            outcome_code = "ai_cancelled"
            raise
        finally:
            # Shielded: a disconnected client cancels through an anyio cancel scope, which would cancel every
            # await here again and leave the CLI unreaped, the directory behind and the outcome unlogged.
            with anyio.CancelScope(shield=True):
                if proc is not None:
                    await _terminate(proc)
                if stderr_task is not None:
                    stderr_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await stderr_task
            shutil.rmtree(workdir, ignore_errors=True)
            duration = int((time.monotonic() - started) * 1000)
            if outcome_code != "ai_cancelled":
                self.last_run = RunOutcome(
                    ok=outcome_code is None,
                    code=outcome_code,
                    at=datetime.now(UTC).isoformat(),
                    duration_ms=duration,
                )
            logger.info(
                "claude run finished code=%s duration_ms=%d prompt_chars=%d",
                outcome_code or "ok",
                duration,
                len(prompt),
            )

    def _handle(self, event: dict[str, Any], state: _RunState) -> str | None:
        kind = event.get("type")
        if kind == "system" and event.get("subtype") == "init":
            if event.get("tools") or event.get("mcp_servers"):
                raise WorkerError(
                    "ai_unsafe_cli_config",
                    "Claude Code запустился с инструментами или MCP-серверами — запрос прерван.",
                )
        elif kind == "stream_event":
            inner = _dict(event.get("event"))
            if inner.get("type") == "content_block_start":
                block = _dict(inner.get("content_block"))
                if block.get("type") not in _TEXT_BLOCKS:
                    raise WorkerError(
                        "ai_tool_use_blocked", "Claude Code пытался вызвать инструмент — запрос прерван."
                    )
            elif inner.get("type") == "content_block_delta":
                delta = _dict(inner.get("delta"))
                if delta.get("type") == "text_delta" and isinstance(delta.get("text"), str):
                    state.output_chars += len(delta["text"])
                    if state.output_chars > self.config.max_output_chars:
                        raise WorkerError("ai_response_too_large", "Ответ Claude превышает лимит размера.")
                    return str(delta["text"])
        elif kind == "assistant":
            content = _list(_dict(event.get("message")).get("content"))
            if any(isinstance(c, dict) and c.get("type") in ("tool_use", "server_tool_use") for c in content):
                raise WorkerError(
                    "ai_tool_use_blocked", "Claude Code пытался вызвать инструмент — запрос прерван."
                )
            if isinstance(event.get("error"), str):
                state.assistant_error = event["error"]
        elif kind == "result":
            state.result = event
        return None

    # --- health ------------------------------------------------------------------------------
    async def cli_version(self) -> str | None:
        now = time.monotonic()
        if self._version and now - self._version[0] < 300:
            return self._version[1]
        version: str | None = None
        try:
            out = await _run_quick([*self.config.cli_command, "--version"], self.config, None)
            match = re.search(r"\d+\.\d+\.\d+", out)
            version = match.group(0) if match else None
        except WorkerError:
            version = None
        self._version = (now, version)
        return version

    async def auth_status(self) -> dict[str, Any]:
        """`claude auth status --json` — a local CLI check; only non-identifying fields are kept."""
        now = time.monotonic()
        if self._auth_status and now - self._auth_status[0] < 300:
            return self._auth_status[1]
        status: dict[str, Any] = {}
        try:
            out = await _run_quick(
                [*self.config.cli_command, "auth", "status", "--json"], self.config, self.read_token()
            )
            data = json.loads(out)
            if isinstance(data, dict):
                status = {
                    k: data.get(k)
                    for k in ("loggedIn", "authMethod", "apiProvider", "subscriptionType")
                    if k in data
                }
        except (WorkerError, ValueError):
            status = {}
        self._auth_status = (now, status)
        return status

    async def health(self) -> dict[str, Any]:
        version = await self.cli_version()
        auth = await self.auth_status() if version else {}
        last = self.last_run
        return {
            "cli_available": version is not None,
            "cli_version": version,
            "auth_source": self.auth_source(),
            "logged_in": bool(auth.get("loggedIn")),
            "auth_method": auth.get("authMethod"),
            "subscription_type": auth.get("subscriptionType"),
            "last_run": None
            if last is None
            else {"ok": last.ok, "code": last.code, "at": last.at, "duration_ms": last.duration_ms},
            "active": self.active,
            "max_concurrency": self.config.max_concurrency,
            "model": self.config.model or None,
            "tools": "disabled",
        }


def _dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _remaining(deadline: float) -> float:
    return max(0.01, deadline - asyncio.get_running_loop().time())


async def _read_events(stream: asyncio.StreamReader, deadline: float) -> AsyncGenerator[dict[str, Any], None]:
    while True:
        try:
            line = await asyncio.wait_for(stream.readline(), timeout=_remaining(deadline))
        except ValueError as exc:  # a single line above the limit
            raise WorkerError(
                "ai_response_too_large", "Событие Claude Code превышает лимит размера."
            ) from exc
        if not line:
            return
        text = line.strip()
        if not text:
            continue
        try:
            event = json.loads(text)
        except ValueError:
            continue  # the CLI may print non-JSON diagnostics; they are never forwarded
        if isinstance(event, dict):
            yield event


async def _drain(stream: asyncio.StreamReader) -> int:
    """Consume stderr to EOF so the CLI never blocks on a full pipe. Content is discarded, never logged."""
    total = 0
    while chunk := await stream.read(8192):
        total += len(chunk)
    return total


async def _terminate(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        return
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(proc.pid, signal.SIGTERM)
    try:
        await asyncio.wait_for(proc.wait(), timeout=3)
    except TimeoutError:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGKILL)
        await proc.wait()


async def _run_quick(argv: Sequence[str], config: WorkerConfig, token: str | None) -> str:
    """Short auxiliary CLI call (version, auth status) with the same isolation rules."""
    Path(config.home_dir).mkdir(parents=True, exist_ok=True)
    Path(config.runs_dir).mkdir(parents=True, exist_ok=True)
    workdir = tempfile.mkdtemp(prefix="aux-", dir=config.runs_dir)
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            cwd=workdir,
            env=build_env(config, token),
            start_new_session=True,
        )
    except (FileNotFoundError, PermissionError) as exc:
        shutil.rmtree(workdir, ignore_errors=True)
        raise WorkerError("ai_cli_unavailable", "Claude Code CLI не найден в воркере.") from exc
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=20)
    except TimeoutError as exc:
        raise WorkerError("ai_timeout", "Claude Code CLI не ответил.") from exc
    finally:
        with anyio.CancelScope(shield=True):
            await _terminate(proc)
        shutil.rmtree(workdir, ignore_errors=True)
    return out.decode("utf-8", "replace")[:65536]


CHECK_SYSTEM_PROMPT = "Ты проверка доступности. Ответь ровно одним словом: OK"
CHECK_PROMPT = "Проверка связи."


@dataclass
class CheckResult:
    ok: bool
    code: str | None = None
    message: str | None = None
    duration_ms: int = 0
    extra: dict[str, Any] = field(default_factory=dict)


async def run_check(runner: ClaudeCLIRunner, timeout: float = 60) -> CheckResult:
    """A minimal real request: proves the CLI, the authorization and the network path."""
    started = time.monotonic()
    text = ""
    try:
        async with contextlib.aclosing(
            runner.run(CHECK_SYSTEM_PROMPT, CHECK_PROMPT, timeout=timeout)
        ) as events:
            async for event in events:
                if event["type"] == "result":
                    text = event["text"]
    except WorkerError as exc:
        return CheckResult(
            ok=False, code=exc.code, message=exc.message, duration_ms=int((time.monotonic() - started) * 1000)
        )
    return CheckResult(
        ok=bool(text.strip()),
        duration_ms=int((time.monotonic() - started) * 1000),
        extra={"answer_chars": len(text)},
    )
