"""Integration configuration: secrets from files, corporate CA bundles, offline preflight."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

import certifi
import pytest
from pydantic import ValidationError

from app import preflight
from app.config import Settings, security_violations, tls_verify
from app.container import ConfigurationError, build_repository

SECRET = "glpat-live-secret-should-never-print-123"


def write(path: Path, text: str) -> Path:
    path.write_text(text, encoding="utf-8")
    return path


def test_token_is_read_from_file(settings_factory: Callable[..., Settings], tmp_path: Path) -> None:
    token_file = write(tmp_path / "gitlab_token", f"{SECRET}\n")
    settings = settings_factory(gitlab_token_file=str(token_file))
    assert settings.gitlab_token.get_secret_value() == SECRET
    assert SECRET not in repr(settings)


@pytest.mark.parametrize("content", ["", "   \n"])
def test_empty_secret_file_is_rejected(
    settings_factory: Callable[..., Settings], tmp_path: Path, content: str
) -> None:
    with pytest.raises(ValidationError) as exc:
        settings_factory(confluence_mcp_auth_token_file=str(write(tmp_path / "t", content)))
    assert "пуст" in str(exc.value)


def test_missing_secret_file_and_ambiguous_values(
    settings_factory: Callable[..., Settings], tmp_path: Path
) -> None:
    with pytest.raises(ValidationError):
        settings_factory(ai_api_key_file=str(tmp_path / "absent"))
    token_file = write(tmp_path / "t", SECRET)
    with pytest.raises(ValidationError) as exc:
        settings_factory(gitlab_token="direct-value", gitlab_token_file=str(token_file))
    assert SECRET not in str(exc.value) and "direct-value" not in str(exc.value)


def test_ca_bundle(settings_factory: Callable[..., Settings]) -> None:
    settings = settings_factory()
    assert tls_verify(settings, "") is True
    assert tls_verify(settings, certifi.where()) is not True  # an SSLContext built from the bundle
    with pytest.raises(ValueError):
        tls_verify(settings, "/nonexistent/corporate-ca.pem")


def test_gitlab_repository_with_missing_ca_fails_closed(settings_factory: Callable[..., Settings]) -> None:
    settings = settings_factory(
        knowledge_backend="gitlab",
        gitlab_url="https://gitlab.test.example",
        gitlab_project_id="42",
        gitlab_token="t",
        gitlab_ca_bundle="/nonexistent/ca.pem",
    )
    with pytest.raises(ConfigurationError):
        build_repository(settings)


def test_web_base_url_must_be_allowlisted(settings_factory: Callable[..., Settings]) -> None:
    bad = settings_factory(
        confluence_web_base_url="https://other.example", confluence_link_hosts="confluence.test.example"
    )
    assert any("CONFLUENCE_WEB_BASE_URL" in p for p in security_violations(bad))
    good = settings_factory(
        confluence_web_base_url="https://confluence.test.example/wiki",
        confluence_link_hosts="confluence.test.example",
    )
    assert security_violations(good) == []


def _clear_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "KNOWLEDGE_BACKEND",
        "GITLAB_URL",
        "GITLAB_PROJECT_ID",
        "GITLAB_TOKEN",
        "GITLAB_TOKEN_FILE",
        "CONFLUENCE_CONNECTOR",
        "AI_PROVIDER",
    ):
        monkeypatch.delenv(name, raising=False)


def test_preflight_default_is_offline_and_clean(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    _clear_env(monkeypatch)
    assert preflight.main([]) == 0
    out = capsys.readouterr().out
    assert "нет (полностью офлайн)" in out
    assert "Сетевые подключения при этой проверке не выполнялись." in out


def test_preflight_reports_integration_gaps_without_secrets(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    _clear_env(monkeypatch)
    monkeypatch.setenv("KNOWLEDGE_BACKEND", "gitlab")
    monkeypatch.setenv("GITLAB_URL", "https://gitlab.test.example")
    monkeypatch.setenv("GITLAB_PROJECT_ID", "group/knowledge")
    monkeypatch.setenv("GITLAB_TOKEN_FILE", str(write(tmp_path / "gitlab_token", SECRET)))
    monkeypatch.setenv("CONFLUENCE_CONNECTOR", "mcp")
    monkeypatch.setenv("CONFLUENCE_MCP_URL", "https://mcp.test.example/mcp")
    assert preflight.main(["--json"]) == 1  # tool map and spaces are still missing
    report = json.loads(capsys.readouterr().out)
    assert SECRET not in json.dumps(report)
    levels = {(c["area"], c["item"]): c["level"] for c in report["checks"]}
    assert levels[("GitLab", "подключение")] == "ok"
    assert levels[("Confluence MCP", "CONFLUENCE_MCP_TOOL_MAP")] == "error"
    assert levels[("Confluence MCP", "пространства")] == "error"
    assert any("gitlab.test.example" in h for h in report["outbound_hosts"])
    assert any("mcp.test.example" in h for h in report["outbound_hosts"])
    tokens = {c["message"] for c in report["checks"] if c["item"] == "GITLAB_TOKEN"}
    assert tokens == {"задан (из файла)"}
