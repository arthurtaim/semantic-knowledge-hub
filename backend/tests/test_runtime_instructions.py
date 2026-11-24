"""Runtime instructions of the in-app assistant (M5.6.2 Appendix 4 §5–6)."""

from __future__ import annotations

import shutil
from pathlib import Path

from fastapi.testclient import TestClient

from app.domain.instructions import DEFAULT_INSTRUCTIONS_DIR, FALLBACK_POLICY, load_instructions


def test_default_instructions_compose_per_task() -> None:
    loaded = load_instructions()
    assert not loaded.fallback and loaded.errors == ()
    assert loaded.version.startswith("instr-")
    answer = loaded.for_task("answer")
    assert "confluence_mcp" in answer and "статус не" in answer and "дословной" in answer
    assert "Шаблоны:" not in answer  # template policy is for authoring only
    authoring = loaded.for_task("authoring")
    assert "Шаблоны:" in authoring and "Требует уточнения" in authoring
    assert "Цитирование:" not in loaded.for_task("edit")


def test_changed_or_missing_files_change_the_version_or_fall_back_safely(tmp_path: Path) -> None:
    directory = tmp_path / "instructions"
    shutil.copytree(DEFAULT_INSTRUCTIONS_DIR, directory)
    original = load_instructions(directory).version
    path = directory / "CITATION_POLICY.md"
    path.write_text(
        path.read_text(encoding="utf-8").replace("version: 1", "version: 2") + "\n- Новое правило.\n"
    )
    changed = load_instructions(directory)
    assert changed.version != original and not changed.fallback
    (directory / "ROLE.md").unlink()
    broken = load_instructions(directory)
    assert broken.fallback and broken.version.startswith("fallback-")
    assert any("role" in e for e in broken.errors)
    assert broken.for_task("answer") == FALLBACK_POLICY  # never a silently weaker prompt


def test_version_is_reported_by_the_api_and_every_answer(client: TestClient) -> None:
    info = client.get("/api/assistant/instructions").json()
    assert info["version"].startswith("instr-") and not info["fallback"]
    assert {f["id"] for f in info["files"]} >= {"role", "retrieval_grounding", "citation_policy"}
    assert "text" not in str(info["files"])  # the prompt text itself is not exposed
    answer = client.post(
        "/api/assistant/ask", json={"question": "Где хранится каноническая база знаний команды?"}
    ).json()
    assert answer["instructions_version"] == info["version"]
    assert answer["index_generation"].startswith("g")
