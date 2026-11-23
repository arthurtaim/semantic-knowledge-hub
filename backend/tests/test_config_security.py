"""Fail-closed configuration and HTTP guards (SECURITY.md, AC-16)."""

from __future__ import annotations

from collections.abc import Callable

import pytest
from fastapi.testclient import TestClient

from app.config import InsecureConfigurationError, Settings, is_loopback_host, security_violations
from app.main import create_app


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "::1", "[::1]", "127.0.0.5"])
def test_loopback_hosts(host: str) -> None:
    assert is_loopback_host(host)


@pytest.mark.parametrize("host", ["0.0.0.0", "10.0.0.5", "example.org", "192.168.1.1", ""])
def test_non_loopback_hosts(host: str) -> None:
    assert not is_loopback_host(host)


def test_default_settings_are_safe(settings_factory: Callable[..., Settings]) -> None:
    settings = settings_factory()
    assert settings.ai_provider == "mock"
    assert settings.confluence_connector == "disabled"
    assert settings.confluence_publish_enabled is False
    assert settings.gitlab_proposals_enabled is False
    assert security_violations(settings) == []


def test_local_demo_on_public_interface_is_rejected(settings_factory: Callable[..., Settings]) -> None:
    settings = settings_factory(app_host="0.0.0.0")
    assert security_violations(settings)
    with pytest.raises(InsecureConfigurationError):
        create_app(settings)


def test_container_mode_requires_loopback_publication(settings_factory: Callable[..., Settings]) -> None:
    ok = settings_factory(app_host="0.0.0.0", app_container=True, app_published_host="127.0.0.1")
    assert security_violations(ok, in_container=True) == []
    exposed = settings_factory(app_host="0.0.0.0", app_container=True, app_published_host="0.0.0.0")
    assert any("loopback" in p for p in security_violations(exposed, in_container=True))


def test_container_flag_is_ignored_outside_containers(settings_factory: Callable[..., Settings]) -> None:
    claimed = settings_factory(app_host="0.0.0.0", app_container=True, app_published_host="127.0.0.1")
    assert any("APP_HOST" in p for p in security_violations(claimed, in_container=False))


@pytest.mark.parametrize(
    "origins", ["*", "https://evil.example", "http://localhost:5173,https://kb.example.org"]
)
def test_cors_origins_must_be_loopback(settings_factory: Callable[..., Settings], origins: str) -> None:
    assert any("CORS_ORIGINS" in p for p in security_violations(settings_factory(cors_origins=origins)))


def test_loopback_cors_origin_allowed(settings_factory: Callable[..., Settings]) -> None:
    assert (
        security_violations(settings_factory(cors_origins="http://localhost:5173,http://127.0.0.1:4173"))
        == []
    )


def test_http_client_logs_are_quiet(client: TestClient) -> None:
    import logging

    assert logging.getLogger("httpx").getEffectiveLevel() >= logging.WARNING


def test_local_demo_in_production_is_rejected(settings_factory: Callable[..., Settings]) -> None:
    assert security_violations(settings_factory(app_env="production"))


def test_non_loopback_allowed_hosts_rejected(settings_factory: Callable[..., Settings]) -> None:
    assert security_violations(settings_factory(allowed_hosts="localhost,kb.example.org"))
    assert security_violations(settings_factory(allowed_hosts="*"))


def test_sso_mode_not_silently_accepted(settings_factory: Callable[..., Settings]) -> None:
    assert any("sso" in p.lower() for p in security_violations(settings_factory(auth_mode="sso")))


def test_ai_host_must_be_allowlisted(settings_factory: Callable[..., Settings]) -> None:
    settings = settings_factory(
        integration_profile="live_read_only",
        ai_provider="internal_api",
        ai_base_url="https://llm.internal.example/v1",
        ai_model="m",
    )
    assert any("AI_ALLOWED_HOSTS" in p for p in security_violations(settings))
    allowed = settings_factory(
        integration_profile="live_read_only",
        ai_provider="internal_api",
        ai_base_url="https://llm.internal.example/v1",
        ai_model="m",
        ai_allowed_hosts="llm.internal.example",
    )
    assert security_violations(allowed) == []


def test_foreign_host_header_rejected(client: TestClient) -> None:
    response = client.get("/api/health", headers={"Host": "evil.example"})
    assert response.status_code == 400
    assert response.json()["code"] == "host_not_allowed"


def test_ipv6_loopback_host_header_allowed(client: TestClient) -> None:
    assert client.get("/api/health", headers={"Host": "[::1]:8000"}).status_code == 200


def test_state_changing_requests_require_client_header(client: TestClient) -> None:
    response = client.post("/api/assistant/ask", json={"question": "ARIS?"}, headers={"X-SKH-Client": ""})
    assert response.status_code == 403
    assert response.json()["code"] == "csrf_header_missing"


def test_health_contract(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["mode"] == "local_demo"
    assert "X-Request-ID" in response.headers
    assert response.headers["X-Content-Type-Options"] == "nosniff"


def test_errors_are_structured(client: TestClient) -> None:
    response = client.get("/api/documents/UNKNOWN-404")
    assert response.status_code == 404
    body = response.json()
    assert set(body) >= {"code", "message", "request_id"}
    assert body["request_id"] == response.headers["X-Request-ID"]


def test_validation_errors_do_not_echo_input(client: TestClient) -> None:
    secret_like = "x" * 3000
    response = client.post("/api/assistant/ask", json={"question": secret_like})
    assert response.status_code == 422
    assert secret_like not in response.text


def test_misconfigured_live_integrations_fail_closed(settings_factory: Callable[..., Settings]) -> None:
    from app.container import ConfigurationError

    insecure = (
        {"confluence_connector": "mcp"},  # no MCP URL
        {"confluence_connector": "mcp", "confluence_mcp_url": "http://mcp.internal.example/mcp"},
        {"gitlab_proposals_enabled": True},  # requires the GitLab knowledge backend
        {"confluence_publish_enabled": True},  # requires a configured test Confluence REST URL
        {"knowledge_backend": "gitlab"},  # offline profile: no integrations at all
    )
    for overrides in insecure:
        with pytest.raises(InsecureConfigurationError):
            create_app(settings_factory(**overrides))
    for overrides in (
        {"integration_profile": "live_read_only", "knowledge_backend": "gitlab"},  # no URL / project / token
        {
            "integration_profile": "live_read_only",
            "knowledge_backend": "gitlab",
            "gitlab_url": "https://gitlab.internal.example",
            "gitlab_project_id": "7",
        },
    ):
        with pytest.raises(ConfigurationError):
            create_app(settings_factory(**overrides))


def test_openapi_schema_without_third_party_docs_ui(client: TestClient) -> None:
    assert client.get("/api/openapi.json").status_code == 200
    assert client.get("/api/docs").status_code == 404
