"""Internal HTTP API of the worker. Reachable only from the backend over a dedicated internal Docker
network (`ai`); it has no published port, no OpenAPI page and no access to application data.

POST /v1/run    {system_prompt, prompt, timeout_seconds?} → NDJSON stream:
                {"type":"status","state":"started"} · {"type":"delta","text"} · {"type":"result",…} | {"type":"error",code,message}
POST /v1/check  minimal real request (CLI + authorization + network) → {"ok", "code"?, "duration_ms"}
GET  /v1/health CLI version, auth source (never the token), last run outcome, concurrency
"""

from __future__ import annotations

import contextlib
import json
import logging
from collections.abc import AsyncIterator
from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from claude_worker.runner import ClaudeCLIRunner, WorkerConfig, WorkerError, run_check

logger = logging.getLogger("skh.claude_worker")

BUSY = {
    "type": "error",
    "code": "ai_busy",
    "message": "Claude Code уже обрабатывает запрос. Повторите через минуту.",
}


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    system_prompt: str = Field(min_length=1, max_length=20_000)
    prompt: str = Field(min_length=1, max_length=200_000)
    timeout_seconds: float | None = Field(default=None, gt=0, le=600)


def _line(event: dict[str, Any]) -> bytes:
    return (json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8")


def create_worker_app(config: WorkerConfig | None = None) -> FastAPI:
    runner = ClaudeCLIRunner(config or WorkerConfig.from_env())
    app = FastAPI(title="SKH Claude worker", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.runner = runner

    @app.get("/v1/health")
    async def health() -> dict[str, Any]:
        return await runner.health()

    @app.post("/v1/run")
    async def run(payload: RunRequest) -> StreamingResponse:
        async def stream() -> AsyncIterator[bytes]:
            # The slot is taken inside the stream: a request whose body is never consumed holds nothing.
            if not runner.try_acquire():
                yield _line(BUSY)
                return
            try:
                yield _line({"type": "status", "state": "started"})
                async with contextlib.aclosing(
                    runner.run(payload.system_prompt, payload.prompt, timeout=payload.timeout_seconds)
                ) as events:
                    async for event in events:
                        yield _line(event)
            except WorkerError as exc:
                yield _line({"type": "error", "code": exc.code, "message": exc.message})
            finally:
                runner.release()

        return StreamingResponse(
            stream(),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    @app.post("/v1/check", response_model=None)
    async def check() -> JSONResponse:
        if not runner.try_acquire():
            return JSONResponse(
                {"ok": False, "code": BUSY["code"], "message": BUSY["message"]}, status_code=429
            )
        try:
            result = await run_check(runner)
        finally:
            runner.release()
        body = {
            "ok": result.ok,
            "code": result.code,
            "message": result.message,
            "duration_ms": result.duration_ms,
        }
        return JSONResponse(body, status_code=200 if result.ok else 503)

    return app
