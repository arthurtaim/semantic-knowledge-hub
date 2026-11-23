"""Opt-in readiness probe: `python -m app.readiness [--json]`.

Unlike `app.preflight` (offline), this DOES contact the configured endpoints — read-only, through the
application's own adapters (GitLab project/branch, MCP initialize + tools/list, Confluence space +
parent page, AI /models). Nothing is written. Each result is labelled with its target: `local`,
`mock` (declared local test double), `real` (a real server) or `none` (not configured).

A successful probe of a real server shows reachability and read access at this moment. It is NOT a
live validation of the integration — that is a separate, approved procedure
(docs/STAGING_TEST_RUNBOOK.md). Exit code: 0 = all configured integrations answered, 1 = otherwise.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from app.adapters.knowledge.base import RepositoryUnavailableError
from app.config import InsecureConfigurationError, Settings, security_violations
from app.container import ConfigurationError, build_container
from app.domain.models import IntegrationStatus

LABELS = {"none": "не настроено", "local": "локально", "mock": "тестовый дубль", "real": "реальный сервер"}


async def probe(settings: Settings) -> list[IntegrationStatus]:
    container = build_container(settings)
    try:
        await container.knowledge.snapshot(container.demo_user())
    except RepositoryUnavailableError as exc:  # reported through the status below
        print(f"[skh] источник знаний недоступен: {exc.code}", file=sys.stderr)
    try:
        return (await container.integrations.status()).items
    finally:
        container.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only readiness probe of configured integrations.")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    settings = Settings()
    problems = security_violations(settings)
    if problems:
        for problem in problems:
            print(f"[skh] insecure configuration: {problem}", file=sys.stderr)
        return 2
    try:
        items = asyncio.run(probe(settings))
    except (ConfigurationError, InsecureConfigurationError) as exc:
        print(f"[skh] invalid configuration: {exc}", file=sys.stderr)
        return 2
    failing = [i for i in items if i.target in ("mock", "real") and i.state == "error"]
    if args.json:
        print(json.dumps([i.model_dump(mode="json") for i in items], ensure_ascii=False, indent=2))
    else:
        print(f"Профиль: {settings.integration_profile}. Выполнены только запросы чтения.\n")
        for item in items:
            print(f"[{item.state:<9}] {item.title:<45} {LABELS[item.target]:<16} доступ: {item.access}")
            print(f"            {item.human_readable_message}")
        if any(i.target == "real" for i in items):
            print(
                "\nВНИМАНИЕ: ответ реального сервера — это проверка доступности, а не live validation интеграции."
            )
        print(
            "\nИтог:", "все настроенные интеграции ответили" if not failing else f"с ошибкой: {len(failing)}"
        )
    return 1 if failing else 0


if __name__ == "__main__":
    raise SystemExit(main())
