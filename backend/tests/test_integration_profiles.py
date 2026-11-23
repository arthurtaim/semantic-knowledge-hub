"""Run modes (offline / integration_mock / live_read_only / live_write_staging) and the fail-closed
rules for the Confluence REST publisher (E2E-34 at configuration level)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from app.config import Settings, security_violations, valid_mock_host

GITLAB = {
    "knowledge_backend": "gitlab",
    "gitlab_url": "https://gitlab.test.example",
    "gitlab_project_id": "1",
    "gitlab_token": "t",
}
PUBLISHER = {
    **GITLAB,
    "confluence_rest_url": "https://confluence.test.example",
    "confluence_rest_token": "publish-token",
    "confluence_target_space": "SKHTEST",
    "confluence_parent_page_id": "123",
}


def problems(factory: Callable[..., Settings], **overrides: Any) -> list[str]:
    return security_violations(factory(**overrides))


def test_default_is_offline_without_integrations(settings_factory: Callable[..., Settings]) -> None:
    settings = settings_factory()
    assert settings.integration_profile == "offline" and security_violations(settings) == []
    assert any("offline" in p for p in problems(settings_factory, **GITLAB))


@pytest.mark.parametrize(
    ("host", "ok"),
    [
        ("127.0.0.1", True),
        ("localhost", True),
        ("gitlab.mock.example", True),
        ("confluence.test", True),
        ("gitlab-mock", True),
        ("gitlab", False),  # could resolve through a corporate DNS search domain
        ("gitlab.corp.bank", False),
        ("10.0.0.5", False),
    ],
)
def test_mock_hosts_are_restricted(host: str, ok: bool) -> None:
    assert valid_mock_host(host) is ok


def test_integration_mock_only_addresses_declared_doubles(settings_factory: Callable[..., Settings]) -> None:
    mock = {**GITLAB, "integration_profile": "integration_mock", "mock_service_hosts": "gitlab.test.example"}
    assert problems(settings_factory, **mock) == []
    real = {**mock, "mock_service_hosts": ""}
    assert any("не mock: GITLAB_URL" in p for p in problems(settings_factory, **real))
    bad = {**mock, "mock_service_hosts": "gitlab.corp.bank"}
    assert any("MOCK_SERVICE_HOSTS" in p for p in problems(settings_factory, **bad))
    docker = {
        **GITLAB,
        "integration_profile": "integration_mock",
        "mock_service_hosts": "gitlab-mock",
        "gitlab_url": "http://gitlab-mock:8929",
        "gitlab_allow_insecure_http": True,
    }
    assert problems(settings_factory, **docker) == []


def test_live_profiles_need_https_and_read_only_forbids_writes(
    settings_factory: Callable[..., Settings],
) -> None:
    assert problems(settings_factory, integration_profile="live_read_only", **GITLAB) == []
    http = {**GITLAB, "gitlab_url": "http://gitlab.test.example", "gitlab_allow_insecure_http": True}
    assert any("https" in p for p in problems(settings_factory, integration_profile="live_read_only", **http))
    writes = problems(
        settings_factory, integration_profile="live_read_only", gitlab_proposals_enabled=True, **GITLAB
    )
    assert any("GITLAB_PROPOSALS_ENABLED" in p for p in writes)


def test_publisher_requires_complete_separate_configuration(
    settings_factory: Callable[..., Settings],
) -> None:
    base = {**PUBLISHER, "integration_profile": "live_read_only"}
    assert problems(settings_factory, **base) == []  # dry-run only: reads
    for key, expected in (
        ("confluence_target_space", "CONFLUENCE_TARGET_SPACE"),
        ("confluence_parent_page_id", "CONFLUENCE_PARENT_PAGE_ID"),
        ("confluence_rest_token", "CONFLUENCE_REST_TOKEN"),
    ):
        assert any(expected in p for p in problems(settings_factory, **{**base, key: ""})), key
    same = {**base, "confluence_mcp_auth_token": "publish-token"}
    assert any("не должен совпадать с токеном MCP" in p for p in problems(settings_factory, **same))
    local = {k: v for k, v in base.items() if k not in GITLAB}
    assert any("KNOWLEDGE_BACKEND=gitlab" in p for p in problems(settings_factory, **local))
    creds = {**base, "confluence_rest_url": "https://user:pw@confluence.test.example"}
    assert any("учётные данные" in p for p in problems(settings_factory, **creds))


@pytest.mark.parametrize("profile", ["offline", "live_read_only"])
def test_publish_write_refused_outside_mock_and_staging(
    settings_factory: Callable[..., Settings], profile: str
) -> None:
    found = problems(
        settings_factory, **{**PUBLISHER, "integration_profile": profile, "confluence_publish_enabled": True}
    )
    assert any("CONFLUENCE_PUBLISH_ENABLED" in p for p in found)


def test_publish_write_to_mock_allowed_only_for_declared_double(
    settings_factory: Callable[..., Settings],
) -> None:
    mock = {
        **PUBLISHER,
        "integration_profile": "integration_mock",
        "mock_service_hosts": "gitlab.test.example,confluence.test.example",
        "confluence_publish_enabled": True,
    }
    assert problems(settings_factory, **mock) == []
    not_declared = {**mock, "mock_service_hosts": "gitlab.test.example"}
    assert any("CONFLUENCE_REST_URL" in p for p in problems(settings_factory, **not_declared))


def test_staging_write_needs_ack_and_corporate_ca(settings_factory: Callable[..., Settings]) -> None:
    staging = {**PUBLISHER, "integration_profile": "live_write_staging", "confluence_publish_enabled": True}
    found = problems(settings_factory, **staging)
    assert any("CONFLUENCE_PUBLISH_STAGING_ACK" in p for p in found)
    assert any("CONFLUENCE_REST_CA_BUNDLE" in p for p in found)
    ok = {**staging, "confluence_publish_staging_ack": "SKHTEST", "confluence_rest_ca_bundle": "/run/ca.pem"}
    assert problems(settings_factory, **ok) == []
