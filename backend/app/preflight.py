"""Offline configuration check for integration environments: `python -m app.preflight [--json]`.

Reports what is configured, what is missing and which hosts the backend would contact — WITHOUT
opening any network connection. Secret values are never printed (only "set"/"missing" and source).
Exit code: 0 = no errors, 1 = configuration errors.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from urllib.parse import urlsplit

from pydantic import ValidationError

from app.adapters.ai.openai_compatible import validate_endpoint
from app.adapters.corporate.confluence_mcp import parse_result_map, parse_tool_map
from app.adapters.gitlab.client import validate_gitlab_config
from app.config import Settings, security_violations, tls_verify


@dataclass
class Check:
    area: str
    item: str
    level: str  # ok | warning | error | info
    message: str


def _secret_state(settings: Settings, name: str) -> str:
    if getattr(settings, f"{name}_file"):
        return "задан (из файла)"
    return "задан (из окружения)" if getattr(settings, name).get_secret_value() else "не задан"


def _host(url: str) -> str:
    return (urlsplit(url).hostname or "").lower()


def run_checks(settings: Settings) -> tuple[list[Check], list[str]]:
    checks: list[Check] = []
    hosts: list[str] = []

    def add(area: str, item: str, level: str, message: str) -> None:
        checks.append(Check(area, item, level, message))

    for violation in security_violations(settings):
        add("Безопасность", "запуск", "error", violation)
    add("Режим", "AUTH_MODE", "info", settings.auth_mode)
    add("Режим", "INTEGRATION_PROFILE", "info", settings.integration_profile)
    if settings.mock_service_host_list:
        add(
            "Режим",
            "MOCK_SERVICE_HOSTS",
            "info",
            ", ".join(settings.mock_service_host_list) + " (тестовые дубли)",
        )
    if settings.auth_mode == "local_demo" and (
        settings.knowledge_backend == "gitlab" or settings.confluence_connector == "mcp"
    ):
        add(
            "Безопасность",
            "доступ пользователей",
            "warning",
            "Один локальный оператор (local_demo, только loopback). SSO/RBAC не реализованы: корпоративные "
            "данные нельзя открывать другим пользователям (docs/PRODUCTION_BLOCKERS.md).",
        )
    add(
        "Режим",
        "APP_PUBLIC_URL",
        "info",
        settings.app_public_url or "не задан — ссылка на предложение в описание MR не добавляется",
    )

    def ca(area: str, name: str, value: str) -> None:
        if not value:
            add(area, name, "info", "системное хранилище сертификатов")
            return
        try:
            tls_verify(settings, value)
            add(area, name, "ok", "файл CA найден и читается")
        except (ValueError, OSError) as exc:
            add(area, name, "error", str(exc))

    # --- GitLab ---------------------------------------------------------------------------------
    if settings.knowledge_backend == "gitlab":
        problem = validate_gitlab_config(
            settings.gitlab_url,
            settings.gitlab_project_id,
            settings.gitlab_token,
            settings.gitlab_allow_insecure_http,
        )
        add("GitLab", "подключение", "error" if problem else "ok", problem or "параметры заданы")
        add("GitLab", "GITLAB_TOKEN", "info", _secret_state(settings, "gitlab_token"))
        add(
            "GitLab",
            "ветка / путь",
            "info",
            f"{settings.gitlab_default_branch} / {settings.gitlab_knowledge_path or '(корень)'}",
        )
        ca("GitLab", "GITLAB_CA_BUNDLE", settings.gitlab_ca_bundle)
        if settings.gitlab_url:
            hosts.append(f"{_host(settings.gitlab_url)}:443 (GitLab REST API v4)")
        add(
            "GitLab",
            "запись (MR)",
            "warning" if settings.gitlab_proposals_enabled else "info",
            "ВКЛЮЧЕНА: ветки, коммиты и MR создаются после «Готово к ревью»"
            if settings.gitlab_proposals_enabled
            else "выключена (GITLAB_PROPOSALS_ENABLED=false)",
        )
    else:
        add("GitLab", "источник знаний", "info", "локальный workspace (KNOWLEDGE_BACKEND=local)")

    # --- Confluence MCP ------------------------------------------------------------------------
    if settings.confluence_connector == "mcp":
        add(
            "Confluence MCP",
            "CONFLUENCE_MCP_URL",
            "ok" if settings.confluence_mcp_url else "error",
            settings.confluence_mcp_url or "не задан",
        )
        add("Confluence MCP", "токен", "info", _secret_state(settings, "confluence_mcp_auth_token"))
        mapping = parse_tool_map(settings.confluence_mcp_tool_map)
        add(
            "Confluence MCP",
            "CONFLUENCE_MCP_TOOL_MAP",
            "ok" if mapping else "error",
            f"поиск: {mapping.search_tool}, чтение: {mapping.read_tool}"
            if mapping
            else "не задано или некорректно — имена инструментов берутся из tools/list тестового сервера",
        )
        add(
            "Confluence MCP",
            "CONFLUENCE_MCP_RESULT_MAP",
            "ok" if parse_result_map(settings.confluence_mcp_result_map) is not None else "error",
            "по умолчанию" if not settings.confluence_mcp_result_map else "переопределено",
        )
        spaces = settings.confluence_space_list
        add("Confluence MCP", "пространства", "ok" if spaces else "error", ", ".join(spaces) or "не заданы")
        add(
            "Confluence MCP",
            "ссылки",
            "ok" if settings.confluence_link_host_list else "warning",
            ", ".join(settings.confluence_link_host_list) or "не заданы — ссылки будут некликабельными",
        )
        ca("Confluence MCP", "CONFLUENCE_MCP_CA_BUNDLE", settings.confluence_mcp_ca_bundle)
        add(
            "Confluence MCP",
            "модель доступа",
            "warning" if settings.confluence_mcp_auth_model == "service_account" else "error",
            "общий сервисный токен: ACL пользователей Confluence не проверяются"
            if settings.confluence_mcp_auth_model == "service_account"
            else "per_user не реализован (нужен SSO)",
        )
        if settings.confluence_mcp_url:
            hosts.append(f"{_host(settings.confluence_mcp_url)} (MCP Streamable HTTP)")
    else:
        add("Confluence MCP", "коннектор", "info", settings.confluence_connector)
    if not settings.confluence_rest_url:
        add("Confluence REST", "публикация", "ok", "не настроена (CONFLUENCE_REST_URL пуст)")
    else:
        target = settings.target_kind(settings.confluence_rest_url)
        write = settings.confluence_publish_enabled
        add(
            "Confluence REST",
            "режим",
            "warning" if write and target == "real" else "info",
            ("запись разрешена" if write else "только dry-run (запись выключена)")
            + (
                " — тестовый дубль"
                if target == "mock"
                else " — РЕАЛЬНЫЙ сервер, live validation не проводилась"
            ),
        )
        add(
            "Confluence REST",
            "пространство/родитель",
            "info",
            f"{settings.confluence_target_space or '—'} / {settings.confluence_parent_page_id or '—'}",
        )
        add(
            "Confluence REST",
            "CONFLUENCE_REST_TOKEN",
            "info",
            _secret_state(settings, "confluence_rest_token"),
        )
        ca("Confluence REST", "CONFLUENCE_REST_CA_BUNDLE", settings.confluence_rest_ca_bundle)
        hosts.append(f"{_host(settings.confluence_rest_url)} (Confluence DC REST, публикация)")

    # --- AI ------------------------------------------------------------------------------------
    if settings.ai_provider == "internal_api":
        problem = validate_endpoint(
            settings.ai_base_url, settings.ai_allowed_host_list, settings.ai_allow_insecure_http
        )
        if problem is None and not settings.ai_model:
            problem = "AI_MODEL не задан."
        add("AI", "внутренний API", "error" if problem else "ok", problem or f"модель {settings.ai_model}")
        add("AI", "AI_API_KEY", "info", _secret_state(settings, "ai_api_key"))
        ca("AI", "AI_CA_BUNDLE", settings.ai_ca_bundle)
        if settings.ai_base_url:
            hosts.append(f"{_host(settings.ai_base_url)} (OpenAI-совместимый API)")
    else:
        add("AI", "провайдер", "info", settings.ai_provider)
    return checks, hosts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Offline configuration check (no network).")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args(argv)
    try:
        settings = Settings()
    except ValidationError as exc:
        print("Конфигурация не загружается:", file=sys.stderr)
        for error in exc.errors():
            print(
                f"  - {'.'.join(str(p) for p in error['loc']) or 'settings'}: {error['msg']}", file=sys.stderr
            )
        return 1
    checks, hosts = run_checks(settings)
    errors = [c for c in checks if c.level == "error"]
    if args.json:
        print(
            json.dumps(
                {"checks": [asdict(c) for c in checks], "outbound_hosts": hosts, "ok": not errors},
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        marks = {"ok": "OK ", "info": " · ", "warning": "WARN", "error": "ERR "}
        for c in checks:
            print(f"[{marks[c.level]}] {c.area:<15} {c.item:<28} {c.message}")
        print("\nИсходящие подключения, которые выполнит backend:")
        for host in hosts or ["нет (полностью офлайн)"]:
            print(f"  - {host}")
        print("\nСетевые подключения при этой проверке не выполнялись.")
        print("Итог:", "ошибок нет" if not errors else f"ошибок: {len(errors)}")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
