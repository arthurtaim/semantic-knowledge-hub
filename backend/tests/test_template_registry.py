"""Versioned template registry (M5.6.2 §D): new / changed / removed templates and old drafts."""

from __future__ import annotations

import shutil
from collections.abc import Callable
from pathlib import Path

from fastapi.testclient import TestClient

from app.domain.template_registry import TemplateRegistry
from app.domain.templates import DEFAULT_TEMPLATES_DIR

TEMPLATE = """---
template_id: {tid}
title: {title}
description: "Тестовый шаблон."
doc_type: dataset
id_prefix: SEM-TST
default_tags: [test]
order: 90
version: {version}
---
{sections}
"""


def write_template(
    directory: Path, tid: str, sections: list[str], *, version: int = 1, title: str = "Тест"
) -> Path:
    body = "\n\n".join(f"## {s}\n> Требует уточнения: {s.lower()}." for s in sections)
    path = directory / f"{tid}.md"
    path.write_text(TEMPLATE.format(tid=tid, title=title, version=version, sections=body), encoding="utf-8")
    return path


def test_shipped_templates_keep_integration_v1_in_history(tmp_path: Path) -> None:
    registry = TemplateRegistry(DEFAULT_TEMPLATES_DIR, tmp_path / "state.sqlite3")
    active = registry.active()
    assert active["integration"].version == 2
    assert "Происхождение данных (Data Lineage)" in active["integration"].sections
    assert "dataset_spec" in active and active["dataset_spec"].doc_type.value == "dataset"
    v1 = registry.get("integration", 1)
    assert v1 is not None and v1.version == 1 and len(v1.sections) == 8
    assert "Происхождение данных (Data Lineage)" not in v1.sections
    assert [v.version for v in registry.versions("integration")] == [1, 2]


def test_new_changed_and_removed_templates(tmp_path: Path) -> None:
    directory = tmp_path / "templates"
    directory.mkdir()
    write_template(directory, "alpha", ["Обзор", "Атрибуты"])
    registry = TemplateRegistry(directory, tmp_path / "state.sqlite3", refresh_seconds=0)
    assert set(registry.active()) == {"alpha"}

    # a new file appears without any code change
    write_template(directory, "beta", ["Обзор"])
    assert set(registry.active()) == {"alpha", "beta"}

    # content changed but the author forgot to bump the version: the registry assigns v2 itself
    write_template(directory, "alpha", ["Обзор", "Атрибуты", "Качество данных"])
    reload = registry.reload()
    assert "alpha@v2" in reload.auto_bumped
    assert registry.active()["alpha"].version == 2
    old = registry.get("alpha", 1)
    assert old is not None and old.sections == ("Обзор", "Атрибуты")

    # an unchanged reload is a no-op (same versions, same label)
    label = registry.label
    assert registry.reload().auto_bumped == [] and registry.label == label

    # a removed template leaves the list for NEW documents but stays readable for existing drafts
    (directory / "beta.md").unlink()
    assert "beta" in registry.reload().removed
    assert "beta" not in registry.active()
    assert registry.get("beta", 1) is not None


def test_registry_survives_restart(tmp_path: Path) -> None:
    directory = tmp_path / "templates"
    directory.mkdir()
    write_template(directory, "alpha", ["Обзор"])
    TemplateRegistry(directory, tmp_path / "state.sqlite3")
    write_template(directory, "alpha", ["Обзор", "Атрибуты"])
    again = TemplateRegistry(directory, tmp_path / "state.sqlite3")
    assert again.active()["alpha"].version == 2  # the remembered checksum of v1 forces a new version
    assert again.get("alpha", 1) is not None


def test_old_draft_is_validated_against_its_template_version(
    tmp_path: Path, client_factory: Callable[..., TestClient]
) -> None:
    directory = tmp_path / "templates"
    shutil.copytree(DEFAULT_TEMPLATES_DIR, directory)
    client = client_factory(document_templates_dir=str(directory))
    template = {t["id"]: t for t in client.get("/api/authoring/templates").json()}["dataset_spec"]
    assert template["version"] == 1
    body = "\n\n".join(f"## {s}\nСодержимое раздела «{s}» тестового датасета." for s in template["sections"])
    created = client.post(
        "/api/authoring/drafts",
        json={
            "template_id": "dataset_spec",
            "metadata": {
                "id": template["suggested_id"],
                "title": "Тестовый датасет",
                "owner": "t",
                "tags": [],
            },
            "body": body,
            "reason": "Проверка версий шаблона",
        },
    )
    assert created.status_code == 201, created.text
    draft = created.json()
    assert draft["template_version"] == 1 and draft["template_current_version"] == 1
    assert "template_version: 1" in draft["proposed_content"]

    # The template gets a new REQUIRED section (version 2) after the draft was created.
    path = directory / "dataset.md"
    text = path.read_text(encoding="utf-8").replace("version: 1", "version: 2")
    path.write_text(text + "\n## Новый обязательный раздел\n> Требует уточнения: новое.\n", encoding="utf-8")
    client.post("/api/index/sync")  # an explicit sync reloads the registry

    fresh = {t["id"]: t for t in client.get("/api/authoring/templates").json()}["dataset_spec"]
    assert fresh["version"] == 2 and fresh["previous_versions"] == [1]
    detail = client.get(f"/api/drafts/{draft['id']}").json()
    assert detail["template_version"] == 1 and detail["template_current_version"] == 2
    form_fields = ("id", "title", "status", "owner", "tags", "related_ids", "source_refs", "summary")
    metadata = {k: v for k, v in detail["new_document"]["metadata"].items() if k in form_fields}
    # Saving the old draft validates against v1: the new section is NOT demanded silently.
    saved = client.put(
        f"/api/drafts/{draft['id']}",
        json={
            "expected_version": detail["edit_version"],
            "metadata": metadata,
            "body": body + "\n\nДополнение.",
            "reason": "Правка старого черновика",
        },
    )
    assert saved.status_code == 200, saved.text
    codes = {i["code"] for i in saved.json()["validation"]}
    assert "template_section_missing" not in codes
    # The /check endpoint used by the editor does the same when given the draft's version.
    checked = client.post(
        "/api/authoring/check",
        json={
            "template_id": "dataset_spec",
            "template_version": 1,
            "metadata": metadata,
            "body": body,
            "exclude_proposal_id": draft["id"],
        },
    ).json()
    assert "template_section_missing" not in {i["code"] for i in checked["validation"]}
    current = client.post(
        "/api/authoring/check",
        json={"template_id": "dataset_spec", "metadata": metadata, "body": body},
    ).json()
    assert "template_section_missing" in {i["code"] for i in current["validation"]}
