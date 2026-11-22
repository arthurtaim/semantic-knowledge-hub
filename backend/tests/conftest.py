"""Shared fixtures. Every test runs against a temporary workspace seeded from synthetic fixtures,
with outbound network connections blocked (offline guarantee, AC-16/AC-20)."""

from __future__ import annotations

import shutil
import socket
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURES_DIR = PROJECT_ROOT / "fixtures" / "knowledge"
QA_FILE = PROJECT_ROOT / "fixtures" / "qa" / "curated_questions.yaml"
CLIENT_HEADERS = {"X-SKH-Client": "test"}


class NetworkBlockedError(RuntimeError):
    pass


@pytest.fixture(autouse=True)
def _block_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def guard(*args: Any, **kwargs: Any) -> None:
        raise NetworkBlockedError("outbound network access attempted during tests")

    monkeypatch.setattr(socket.socket, "connect", guard)
    monkeypatch.setattr(socket.socket, "connect_ex", guard)
    monkeypatch.setattr(socket, "create_connection", guard)


def write_doc(root: Path, name: str, text: str) -> Path:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def make_doc(
    doc_id: str,
    *,
    title: str = "Тестовый документ",
    status: str = "approved",
    doc_type: str = "process",
    owner: str = "test-team",
    tags: str = "[test, demo]",
    body: str = "# Заголовок\n\nСодержимое тестового документа достаточной длины.\n",
    extra: str = "",
) -> str:
    return (
        f"---\nid: {doc_id}\ntitle: {title}\ntype: {doc_type}\nstatus: {status}\nowner: {owner}\n"
        f"tags: {tags}\nreviewed_at: 2026-11-01\n{extra}---\n\n{body}"
    )


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    knowledge = tmp_path / "workspace" / "knowledge"
    shutil.copytree(FIXTURES_DIR, knowledge)
    return knowledge


@pytest.fixture
def settings_factory(tmp_path: Path, workspace: Path) -> Callable[..., Settings]:
    def factory(**overrides: Any) -> Settings:
        values: dict[str, Any] = {
            "app_env": "test",
            "project_root": tmp_path,
            "local_knowledge_dir": workspace,
            "fixtures_dir": FIXTURES_DIR,
            "seed_fixtures": False,
            "search_index_path": tmp_path / "workspace" / "search.sqlite3",
            "app_state_path": tmp_path / "workspace" / "app_state.sqlite3",
            "repository_refresh_seconds": 0.0,
            "ai_provider": "mock",
            "confluence_connector": "disabled",
        }
        values.update(overrides)
        return Settings(_env_file=None, **values)  # type: ignore[call-arg]

    return factory


@pytest.fixture
def client_factory(settings_factory: Callable[..., Settings]) -> Iterator[Callable[..., TestClient]]:
    clients: list[TestClient] = []

    def factory(**overrides: Any) -> TestClient:
        app = create_app(settings_factory(**overrides))
        client = TestClient(app, base_url="http://localhost", headers=CLIENT_HEADERS)
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for client in clients:
        client.__exit__(None, None, None)


@pytest.fixture
def client(client_factory: Callable[..., TestClient]) -> TestClient:
    return client_factory()
