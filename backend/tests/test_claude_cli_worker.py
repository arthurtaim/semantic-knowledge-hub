"""Claude Code CLI worker against the MOCK CLI (tests/support/fake_claude_cli.py) — no subscription, no network.
Covers the isolation rules of docs/CLAUDE_CODE_CLI_INTEGRATION.md §6 and the failure handling of §5."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest

from claude_worker.app import create_worker_app
from claude_worker.runner import (
    SAFETY_ARGS,
    ClaudeCLIRunner,
    WorkerConfig,
    WorkerError,
    build_argv,
    build_env,
    classify_failure,
)

FAKE_CLI = Path(__file__).parent / "support" / "fake_claude_cli.py"
TOKEN = "FAKE-TEST-TOKEN-not-real-0123456789abcdef"
SYSTEM = "Системный промпт теста."
PROMPT = "Вопрос пользователя:\nЧто такое ARIS?\n\n<<<PASSAGE C1>>>\n{}\nARIS — синтетическая система для демо-интеграции.\n<<<END C1>>>"


def make_config(tmp_path: Path, mode: str = "ok", *, token: bool = True, **extra: Any) -> WorkerConfig:
    token_file = tmp_path / "claude_token"
    if token:
        token_file.write_text(TOKEN + "\n", encoding="utf-8")
    record = tmp_path / "record.json"
    args = [sys.executable, str(FAKE_CLI), f"--fake-mode={mode}", f"--fake-record={record}"]
    if "sleep" in extra:
        args.append(f"--fake-sleep={extra.pop('sleep')}")
    return WorkerConfig(
        cli_command=tuple(args),
        token_file=str(token_file) if token else "",
        home_dir=str(tmp_path / "home"),
        runs_dir=str(tmp_path / "runs"),
        **extra,
    )


def record(tmp_path: Path) -> dict[str, Any]:
    return json.loads((tmp_path / "record.json").read_text(encoding="utf-8"))


async def collect(
    runner: ClaudeCLIRunner, prompt: str = PROMPT, timeout: float | None = None
) -> list[dict[str, Any]]:
    events = []
    async with contextlib.aclosing(runner.run(SYSTEM, prompt, timeout=timeout)) as stream:
        async for event in stream:
            events.append(event)
    return events


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # a zombie still answers kill(0); it is reaped by the worker (`await proc.wait()`), so treat as gone
    return not Path(f"/proc/{pid}/status").exists() or "zombie" not in Path(f"/proc/{pid}/status").read_text()


def test_argv_disables_every_tool_and_keeps_the_prompt_out_of_argv() -> None:
    argv = build_argv(WorkerConfig(), SYSTEM)
    assert argv[:2] == ["claude", "-p"]
    joined = " ".join(argv)
    for flag in (
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--restricted",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
    ):
        assert flag in argv, flag
    assert argv[argv.index("--tools") + 1] == ""  # all built-in tools disabled
    assert argv[argv.index("--mcp-config") + 1] == '{"mcpServers":{}}'
    assert argv[argv.index("--permission-mode") + 1] == "dontAsk"
    assert argv[argv.index("--system-prompt") + 1] == SYSTEM
    assert "--bare" not in argv  # --bare ignores OAuth/subscription auth
    assert "--dangerously-skip-permissions" not in joined and "bypassPermissions" not in joined
    assert tuple(a for a in argv if a in SAFETY_ARGS) and "ARIS" not in joined


def test_child_environment_is_an_allowlist(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GITLAB_TOKEN", "glpat-should-never-leak")
    monkeypatch.setenv("AI_API_KEY", "nope")
    env = build_env(WorkerConfig(home_dir="/tmp/h"), TOKEN)
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == TOKEN
    assert env["HOME"] == "/tmp/h" and env["CLAUDE_CONFIG_DIR"] == "/tmp/h/.claude"
    assert "GITLAB_TOKEN" not in env and "AI_API_KEY" not in env
    assert set(env) <= {
        "PATH",
        "HOME",
        "CLAUDE_CONFIG_DIR",
        "LANG",
        "TMPDIR",
        "DISABLE_AUTOUPDATER",
        "DISABLE_TELEMETRY",
        "DISABLE_ERROR_REPORTING",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        "CLAUDE_CODE_OAUTH_TOKEN",
    }
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in build_env(WorkerConfig(), None)


def test_successful_run_streams_deltas_and_isolates_the_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SKH_SECRET_FROM_PARENT", "parent-secret")
    runner = ClaudeCLIRunner(make_config(tmp_path))
    events = asyncio.run(collect(runner))
    deltas = "".join(e["text"] for e in events if e["type"] == "delta")
    result = events[-1]
    assert result["type"] == "result" and deltas == result["text"]
    assert "ARIS — синтетическая система" in result["text"] and result["usage"]["output_tokens"] == 20
    rec = record(tmp_path)
    assert rec["prompt"] == PROMPT  # the prompt goes through stdin
    assert PROMPT not in " ".join(rec["argv"])
    assert rec["cwd_empty"] and rec["cwd"].startswith(str(tmp_path / "runs"))
    assert not Path(rec["cwd"]).exists()  # per-request directory removed afterwards
    assert rec["token"] == TOKEN
    assert "SKH_SECRET_FROM_PARENT" not in rec["env_keys"]
    assert runner.last_run is not None and runner.last_run.ok


def test_expired_authorization_is_classified_without_echoing_cli_text(tmp_path: Path) -> None:
    runner = ClaudeCLIRunner(make_config(tmp_path, "auth_expired"))
    with pytest.raises(WorkerError) as exc:
        asyncio.run(collect(runner))
    assert exc.value.code == "ai_auth_failed"
    assert "setup-token" in exc.value.message and "/login" not in exc.value.message
    assert runner.last_run is not None and runner.last_run.code == "ai_auth_failed"


def test_missing_token_and_missing_cli(tmp_path: Path) -> None:
    runner = ClaudeCLIRunner(make_config(tmp_path, "auth_expired", token=False))
    assert runner.auth_source() == "none"
    with pytest.raises(WorkerError) as exc:
        asyncio.run(collect(runner))
    assert exc.value.code == "ai_auth_failed"
    missing = ClaudeCLIRunner(
        WorkerConfig(
            cli_command=(str(tmp_path / "no-such-claude"),),
            home_dir=str(tmp_path / "h"),
            runs_dir=str(tmp_path / "r"),
        )
    )
    with pytest.raises(WorkerError) as exc:
        asyncio.run(collect(missing))
    assert exc.value.code == "ai_cli_unavailable"


@pytest.mark.parametrize(
    ("mode", "code"),
    [
        ("rate_limit", "ai_rate_limited"),
        ("tool_use", "ai_tool_use_blocked"),
        ("unsafe_init", "ai_unsafe_cli_config"),
        ("denials", "ai_tool_use_blocked"),
        ("crash", "ai_upstream_error"),
    ],
)
def test_failures_and_safety_violations_abort_the_run(tmp_path: Path, mode: str, code: str) -> None:
    runner = ClaudeCLIRunner(make_config(tmp_path, mode))
    with pytest.raises(WorkerError) as exc:
        asyncio.run(collect(runner))
    assert exc.value.code == code
    assert "secret-ish" not in exc.value.message  # stderr is never surfaced


def test_non_json_lines_are_ignored(tmp_path: Path) -> None:
    events = asyncio.run(collect(ClaudeCLIRunner(make_config(tmp_path, "garbage"))))
    assert events[-1]["type"] == "result" and "warning" not in events[-1]["text"]


def test_timeout_kills_the_process_group(tmp_path: Path) -> None:
    runner = ClaudeCLIRunner(make_config(tmp_path, "slow", sleep=30))
    with pytest.raises(WorkerError) as exc:
        asyncio.run(collect(runner, timeout=1.5))
    assert exc.value.code == "ai_timeout"
    assert not pid_alive(record(tmp_path)["pid"])


def test_cancellation_kills_the_cli(tmp_path: Path) -> None:
    runner = ClaudeCLIRunner(make_config(tmp_path, "slow", sleep=30))

    async def scenario() -> None:
        stream = runner.run(SYSTEM, PROMPT)
        task = asyncio.ensure_future(stream.__anext__())
        for _ in range(100):  # wait until the CLI has started and recorded its pid
            if (tmp_path / "record.json").exists():
                break
            await asyncio.sleep(0.05)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, StopAsyncIteration):
            await task
        await stream.aclose()

    asyncio.run(scenario())
    assert not pid_alive(record(tmp_path)["pid"])
    assert list((tmp_path / "runs").iterdir()) == []  # working directory cleaned up
    assert runner.active == 0


def test_classify_failure_codes() -> None:
    assert classify_failure("authentication_failed", "", None).code == "ai_auth_failed"
    assert classify_failure(None, "OAuth token has expired", None).code == "ai_auth_failed"
    assert classify_failure(None, "x", 429).code == "ai_rate_limited"
    assert classify_failure("billing_error", "", None).code == "ai_auth_failed"
    assert classify_failure(None, "boom", 500).code == "ai_upstream_error"


def _client(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://claude-worker")


async def _run_lines(client: httpx.AsyncClient, prompt: str = PROMPT) -> list[dict[str, Any]]:
    resp = await client.post("/v1/run", json={"system_prompt": SYSTEM, "prompt": prompt})
    assert resp.status_code == 200 and resp.headers["content-type"].startswith("application/x-ndjson")
    return [json.loads(line) for line in resp.text.splitlines() if line.strip()]


def test_http_api_streams_ndjson_and_reports_health_without_secrets(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    app = create_worker_app(make_config(tmp_path))

    async def scenario() -> tuple[list[dict[str, Any]], dict[str, Any]]:
        async with _client(app) as client:
            lines = await _run_lines(client)
            health = (await client.get("/v1/health")).json()
            return lines, health

    lines, health = asyncio.run(scenario())
    assert lines[0] == {"type": "status", "state": "started"}
    assert lines[-1]["type"] == "result"
    assert health["cli_available"] and health["cli_version"] == "2.1.318"
    assert health["auth_source"] == "token_file" and health["logged_in"] is True
    assert health["last_run"]["ok"] is True and health["tools"] == "disabled"
    dumped = json.dumps(health) + json.dumps(lines) + caplog.text
    assert TOKEN not in dumped and "owner@example.invalid" not in dumped and "Personal" not in dumped
    assert "ARIS" not in caplog.text  # prompts and answers are never logged


def test_concurrency_limit_returns_busy(tmp_path: Path) -> None:
    app = create_worker_app(make_config(tmp_path, "slow", sleep=1.5, max_concurrency=1))

    async def scenario() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        async with _client(app) as client:
            first = asyncio.ensure_future(_run_lines(client))
            await asyncio.sleep(0.3)
            second = await _run_lines(client)
            return await first, second

    first, second = asyncio.run(scenario())
    assert second == [{"type": "error", "code": "ai_busy", "message": second[0]["message"]}]
    assert first[-1]["type"] == "result"
    assert app.state.runner.active == 0


def test_check_endpoint_reports_auth_failure(tmp_path: Path) -> None:
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    ok_app = create_worker_app(make_config(tmp_path / "a", "ok"))
    bad_app = create_worker_app(make_config(tmp_path / "b", "auth_expired"))

    async def scenario() -> tuple[httpx.Response, httpx.Response]:
        async with _client(ok_app) as ok, _client(bad_app) as bad:
            return await ok.post("/v1/check"), await bad.post("/v1/check")

    ok_resp, bad_resp = asyncio.run(scenario())
    assert ok_resp.status_code == 200 and ok_resp.json()["ok"] is True
    assert bad_resp.status_code == 503 and bad_resp.json()["code"] == "ai_auth_failed"


def test_request_limits_are_validated(tmp_path: Path) -> None:
    app = create_worker_app(make_config(tmp_path))

    async def scenario() -> list[int]:
        async with _client(app) as client:
            return [
                (
                    await client.post("/v1/run", json={"system_prompt": SYSTEM, "prompt": "x" * 200_001})
                ).status_code,
                (
                    await client.post(
                        "/v1/run", json={"system_prompt": SYSTEM, "prompt": "ok", "tools": "Bash"}
                    )
                ).status_code,
            ]

    assert asyncio.run(scenario()) == [422, 422]


def test_cancellation_inside_an_anyio_cancel_scope_still_cleans_up(tmp_path: Path) -> None:
    """Starlette cancels a disconnected stream through an anyio cancel scope, where every await in cleanup
    code is cancelled again. The CLI must still be killed, the run directory removed and the outcome logged."""
    import anyio

    runner = ClaudeCLIRunner(make_config(tmp_path, "slow", sleep=30))

    async def scenario() -> None:
        async def consume() -> None:
            async with contextlib.aclosing(runner.run(SYSTEM, PROMPT)) as events:
                async for _ in events:
                    pass

        async with anyio.create_task_group() as tg:
            tg.start_soon(consume)
            for _ in range(100):
                if (tmp_path / "record.json").exists():
                    break
                await anyio.sleep(0.05)
            tg.cancel_scope.cancel()

    anyio.run(scenario)
    assert not pid_alive(record(tmp_path)["pid"])
    assert [p.name for p in (tmp_path / "runs").iterdir()] == []
    assert runner.active == 0


def test_egress_proxy_allows_only_connect_to_allowed_hosts_on_443() -> None:
    from claude_worker.egress_proxy import is_allowed, parse_connect

    allowed = frozenset({"api.anthropic.com"})
    assert parse_connect(b"CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: x\r\n\r\n") == (
        "api.anthropic.com",
        443,
    )
    assert is_allowed("api.anthropic.com", 443, allowed)
    assert not is_allowed("api.anthropic.com", 80, allowed)
    assert not is_allowed("evil.example.com", 443, allowed)
    for head in (
        b"GET http://api.anthropic.com/ HTTP/1.1\r\n\r\n",  # plain HTTP proxying
        b"CONNECT 172.17.0.1:8080 HTTP/1.1\r\n\r\n",  # IP literal (other apps on the host)
        b"CONNECT [::1]:443 HTTP/1.1\r\n\r\n",
        b"CONNECT user@api.anthropic.com:443 HTTP/1.1\r\n\r\n",
        b"CONNECT api.anthropic.com HTTP/1.1\r\n\r\n",
        b"CONNECT api.anthropic.com:443\r\n\r\n",
    ):
        assert parse_connect(head) is None, head


def test_child_gets_the_egress_proxy_when_configured() -> None:
    env = build_env(WorkerConfig(egress_proxy="http://egress-proxy:3128"), None)
    assert env["HTTPS_PROXY"] == env["HTTP_PROXY"] == "http://egress-proxy:3128"
    assert "HTTPS_PROXY" not in build_env(WorkerConfig(), None)
