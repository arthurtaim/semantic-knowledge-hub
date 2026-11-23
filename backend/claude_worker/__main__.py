"""`python -m claude_worker` — serve the worker API; `python -m claude_worker check` — one real request
through the configured CLI (opt-in smoke test; prints only the outcome, never prompts, output or tokens)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys

import uvicorn

from claude_worker.app import create_worker_app
from claude_worker.runner import ClaudeCLIRunner, WorkerConfig, run_check


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )
    config = WorkerConfig.from_env()
    if args[:1] == ["check"]:
        runner = ClaudeCLIRunner(config)
        health = asyncio.run(runner.health())
        result = asyncio.run(run_check(runner))
        print(
            json.dumps(
                {
                    "cli_version": health["cli_version"],
                    "auth_source": health["auth_source"],
                    "logged_in": health["logged_in"],
                    "check_ok": result.ok,
                    "code": result.code,
                    "duration_ms": result.duration_ms,
                },
                ensure_ascii=False,
            )
        )
        return 0 if result.ok else 1
    uvicorn.run(
        create_worker_app(config),
        host=os.environ.get("CLAUDE_WORKER_HOST", "127.0.0.1"),
        port=int(os.environ.get("CLAUDE_WORKER_PORT", "8090")),
        log_level=os.environ.get("LOG_LEVEL", "info").lower(),
        access_log=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
