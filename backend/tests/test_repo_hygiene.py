"""GitHub hygiene (AC-19, AC-20): only synthetic fixtures, no secrets, ignored workspaces."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

from app.domain.safety import find_personal_identifiers, find_secrets
from app.domain.schema import parse_document
from tests.conftest import FIXTURES_DIR, PROJECT_ROOT

REQUIRED_IGNORES = [".env", "workspace/", "*.sqlite3", ".mcp.json", "node_modules/", "*.pem", "*.key"]
FORBIDDEN_TRACKED = re.compile(r"(^|/)(\.env(\..+)?|.*\.sqlite3?|.*\.pem|.*\.key|workspace/.*)$")
TEXT_SUFFIXES = {
    ".py",
    ".ts",
    ".tsx",
    ".md",
    ".yaml",
    ".yml",
    ".json",
    ".toml",
    ".conf",
    ".txt",
    ".example",
    ".cfg",
}


def test_gitignore_covers_sensitive_paths() -> None:
    gitignore = (PROJECT_ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    for pattern in REQUIRED_IGNORES:
        assert pattern in gitignore, pattern


def _tracked_or_candidate_files() -> list[str]:
    try:
        output = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard"],  # noqa: S607
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        pytest.skip("git is not available")
    return [line for line in output.splitlines() if line]


def test_no_secrets_or_private_files_would_be_committed() -> None:
    files = _tracked_or_candidate_files()
    assert files, "expected at least some files"
    offenders = [f for f in files if FORBIDDEN_TRACKED.search(f) and not f.endswith(".env.example")]
    assert offenders == []
    leaked: list[str] = []
    for name in files:
        path = PROJECT_ROOT / name
        if path.suffix not in TEXT_SUFFIXES or not path.is_file() or "node_modules" in name:
            continue
        if name.startswith("backend/tests/"):
            continue  # tests intentionally contain fake secret-like strings
        text = path.read_text(encoding="utf-8", errors="ignore")
        is_code = path.suffix in {".py", ".ts", ".tsx"}
        if find_secrets(text, heuristic=not is_code):
            leaked.append(name)
    assert leaked == []


def test_env_example_has_only_placeholders() -> None:
    for line in (PROJECT_ROOT / ".env.example").read_text(encoding="utf-8").splitlines():
        if line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if any(marker in key for marker in ("TOKEN", "API_KEY", "PASSWORD", "SECRET")):
            assert value.strip() == "", f"{key} must be empty in .env.example"
        if key.endswith("_URL"):
            assert value.strip() == "", f"{key} must not contain an internal URL"


@pytest.mark.parametrize("path", sorted(FIXTURES_DIR.glob("*.md")), ids=lambda p: p.name)
def test_fixtures_are_valid_and_marked_synthetic(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    parsed = parse_document(text)
    assert parsed.is_valid, parsed.errors
    assert "demo" in parsed.metadata["tags"]
    assert re.search(r"DEMO ONLY|ДЕМО-ДАННЫЕ", text)
    assert not find_secrets(text)
    assert not find_personal_identifiers(text)


FIXTURES_ROOT = PROJECT_ROOT / "fixtures"
# Knowledge-document fixtures: the base and the sync snapshots. Every document there is synthetic and says so in
# its metadata (AGENTS.md), core SEM-* included. A README is not a document.
FIXTURE_DOCUMENT_ROOTS = (FIXTURES_ROOT / "knowledge", FIXTURES_ROOT / "knowledge_updates")
# Front matter broken on purpose (a sync-rejection fixture): the loader rejects it, so it never becomes a document.
UNPARSABLE_BY_DESIGN = {"knowledge_updates/invalid/broken.md"}


def _fixture_documents() -> list[Path]:
    return sorted(p for root in FIXTURE_DOCUMENT_ROOTS for p in root.rglob("*.md") if p.name != "README.md")


@pytest.mark.parametrize("path", _fixture_documents(), ids=lambda p: p.relative_to(FIXTURES_ROOT).as_posix())
def test_every_fixture_document_carries_synthetic_true(path: Path) -> None:
    relative = path.relative_to(FIXTURES_ROOT).as_posix()
    parsed = parse_document(path.read_text(encoding="utf-8"))
    if relative in UNPARSABLE_BY_DESIGN:
        # The exemption covers only a file the loader rejects; a parsable document here must be marked like any other.
        assert parsed.metadata == {} and not parsed.is_valid, relative
        return
    assert parsed.metadata.get("synthetic") is True, (
        f"{relative}: fixture documents must carry `synthetic: true`"
    )


def test_fixture_document_scan_covers_the_whole_base() -> None:
    documents = _fixture_documents()
    assert sum(1 for p in documents if p.is_relative_to(FIXTURES_ROOT / "knowledge")) == 83
    assert any(p.name.startswith("SEM-") for p in documents)
    assert any(p.is_relative_to(FIXTURES_ROOT / "knowledge_updates") for p in documents)


def test_integration_template_has_no_secrets_or_hosts() -> None:
    template = PROJECT_ROOT / "deploy" / "integration" / "integration.env.example"
    for line in template.read_text(encoding="utf-8").splitlines():
        if line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.endswith("_FILE") or key.endswith("_CA_BUNDLE"):
            assert value == "" or value.startswith("/run/skh-secrets/"), key
        elif any(marker in key for marker in ("TOKEN", "API_KEY", "PASSWORD", "SECRET")):
            assert value.strip() == "", key
        if key.endswith("_URL") or key in ("GITLAB_PROJECT_ID", "CONFLUENCE_LINK_HOSTS", "AI_ALLOWED_HOSTS"):
            assert value.strip() == "", f"{key} must be filled locally, not committed"
    assert "GITLAB_PROPOSALS_ENABLED=false" in template.read_text(encoding="utf-8")
    assert "CONFLUENCE_PUBLISH_ENABLED=false" in template.read_text(encoding="utf-8")


def test_filled_integration_env_is_ignored() -> None:
    try:
        result = subprocess.run(
            ["git", "check-ignore", "deploy/integration/integration.env"],  # noqa: S607
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        pytest.skip("git is not available")
    assert result.returncode == 0
