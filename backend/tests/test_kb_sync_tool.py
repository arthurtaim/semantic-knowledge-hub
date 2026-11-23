"""app.tools.kb_sync: fixtures → existing demo workspace without touching what it does not own."""

from __future__ import annotations

from pathlib import Path

from app.tools.kb_sync import MANIFEST, apply, plan
from tests.conftest import make_doc, write_doc


def test_sync_adds_updates_deletes_only_managed_files(tmp_path: Path) -> None:
    fixtures, workspace = tmp_path / "fixtures", tmp_path / "workspace"
    write_doc(fixtures, "A.md", make_doc("SEM-A"))
    write_doc(fixtures, "sub/B.md", make_doc("SEM-B"))
    write_doc(workspace, "A.md", make_doc("SEM-A"))  # seeded earlier, identical: adopted
    write_doc(workspace, "MINE.md", make_doc("SEM-MINE"))  # created by a user: never touched
    first = apply(fixtures, workspace)
    assert first.add == ["sub/B.md"] and first.adopt == ["A.md"]
    assert (workspace / MANIFEST).is_file() and (workspace / "MINE.md").is_file()

    write_doc(fixtures, "sub/B.md", make_doc("SEM-B", title="Изменённый"))
    write_doc(fixtures, "C.md", make_doc("SEM-C"))
    (fixtures / "A.md").unlink()
    second = apply(fixtures, workspace)
    assert second.update == ["sub/B.md"] and second.add == ["C.md"] and second.delete == ["A.md"]
    assert "Изменённый" in (workspace / "sub" / "B.md").read_text(encoding="utf-8")
    assert not (workspace / "A.md").exists() and (workspace / "MINE.md").is_file()

    # a local edit of a managed file is a conflict: kept, never overwritten
    write_doc(workspace, "C.md", make_doc("SEM-C", title="Правка на месте"))
    write_doc(fixtures, "C.md", make_doc("SEM-C", title="Новая версия фикстуры"))
    third, _ = plan(fixtures, workspace)
    assert third.conflicts == ["C.md"] and third.update == []
    apply(fixtures, workspace)
    assert "Правка на месте" in (workspace / "C.md").read_text(encoding="utf-8")
    # idempotent
    again, _ = plan(fixtures, workspace)
    assert again.add == again.update == again.delete == []
