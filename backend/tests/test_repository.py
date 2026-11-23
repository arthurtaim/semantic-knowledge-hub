"""LocalKnowledgeRepository: loading, quarantine of invalid/duplicate docs, path safety (AC-11, AC-12)."""

from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path

import pytest

from app.adapters.knowledge.base import DocumentNotFoundError, DuplicateDocumentIdError
from app.adapters.knowledge.local import LocalKnowledgeRepository, content_revision, seed_from_fixtures
from app.domain.models import UserContext
from tests.conftest import FIXTURES_DIR, make_doc, write_doc

USER = UserContext(user_id="u", display_name="u")


def repo(root: Path, **kwargs: object) -> LocalKnowledgeRepository:
    return LocalKnowledgeRepository(root, max_document_bytes=64 * 1024, refresh_seconds=0.0, **kwargs)  # type: ignore[arg-type]


def snapshot(r: LocalKnowledgeRepository):  # type: ignore[no-untyped-def]
    return asyncio.run(r.snapshot(USER))


def test_fixtures_load_with_provenance(workspace: Path) -> None:
    snap = snapshot(repo(workspace))
    assert snap.issues == []
    doc = snap.get("sem-int-aris-001")  # case-insensitive lookup
    assert doc is not None
    assert doc.id == "SEM-INT-ARIS-001"
    assert doc.status.value == "draft"
    assert doc.source == "local"
    assert doc.source_uri == "local://SEM-INT-ARIS-001"
    assert doc.revision == content_revision((workspace / "SEM-INT-ARIS-001.md").read_bytes())
    assert doc.is_demo
    assert doc.path == "SEM-INT-ARIS-001.md"


def test_duplicate_ids_are_quarantined(workspace: Path) -> None:
    write_doc(workspace, "dup-a.md", make_doc("DUP-001"))
    write_doc(workspace, "nested/dup-b.md", make_doc("dup-001", title="Другой"))
    r = repo(workspace)
    snap = snapshot(r)
    assert snap.get("DUP-001") is None
    assert {i.code for i in snap.issues} == {"duplicate_id"}
    with pytest.raises(DuplicateDocumentIdError) as exc:
        asyncio.run(r.get_document("DUP-001", USER))
    assert exc.value.paths == ["dup-a.md", "nested/dup-b.md"]


def test_invalid_documents_reported_not_loaded(workspace: Path) -> None:
    write_doc(workspace, "bad.md", "---\nid: [oops\n---\n\n# x\n\nbody body body body")
    (workspace / "latin1.md").write_bytes(
        make_doc("LATIN-1", title="caf\xe9", body="# H\n\nCaf\xe9 body text long enough.\n").encode("latin-1")
    )
    snap = snapshot(repo(workspace))
    codes = {(i.path, i.code) for i in snap.issues}
    assert ("bad.md", "frontmatter_invalid_yaml") in codes
    assert ("latin1.md", "invalid_encoding") in codes


def test_oversized_file_skipped(workspace: Path) -> None:
    write_doc(workspace, "big.md", make_doc("BIG-001", body="# H\n\n" + "x" * 70_000))
    snap = snapshot(repo(workspace))
    assert snap.get("BIG-001") is None
    assert any(i.code == "file_too_large" for i in snap.issues)


@pytest.mark.skipif(os.name == "nt", reason="symlinks need privileges on Windows")
def test_symlinks_never_followed(workspace: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    secret = write_doc(
        outside, "secret.md", make_doc("OUTSIDE-001", body="# Secret\n\nOUTSIDE-MARKER content here.")
    )
    (workspace / "link.md").symlink_to(secret)
    (workspace / "linkdir").symlink_to(outside, target_is_directory=True)
    snap = snapshot(repo(workspace))
    assert snap.get("OUTSIDE-001") is None
    assert {i.code for i in snap.issues} == {"symlink_skipped"}
    assert all("OUTSIDE-MARKER" not in d.raw for d in snap.documents.values())


@pytest.mark.parametrize("bad_id", ["../SEM-ARCH-001", "..%2F..%2Fetc%2Fpasswd", "/etc/passwd", "a/b", ""])
def test_get_document_rejects_path_like_ids(workspace: Path, bad_id: str) -> None:
    with pytest.raises(DocumentNotFoundError):
        asyncio.run(repo(workspace).get_document(bad_id, USER))


def test_changes_on_disk_are_picked_up(workspace: Path) -> None:
    r = repo(workspace)
    before = snapshot(r)
    write_doc(workspace, "new.md", make_doc("NEW-001"))
    after = snapshot(r)
    assert after.version != before.version
    assert after.get("NEW-001") is not None


def test_seed_copies_only_into_empty_workspace(tmp_path: Path) -> None:
    target = tmp_path / "ws"
    assert seed_from_fixtures(FIXTURES_DIR, target) == len(list(FIXTURES_DIR.glob("*.md")))
    marker = target / "SEM-ARCH-001.md"
    marker.write_text(marker.read_text(encoding="utf-8") + "\nlocal edit\n", encoding="utf-8")
    assert seed_from_fixtures(FIXTURES_DIR, target) == 0
    assert "local edit" in marker.read_text(encoding="utf-8")


def test_missing_root_reports_error_status(tmp_path: Path) -> None:
    r = repo(tmp_path / "missing")
    assert asyncio.run(r.status()).state == "error"
    shutil.rmtree(tmp_path, ignore_errors=True)


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="FIFOs need POSIX")
def test_fifo_does_not_hang_the_scan(workspace: Path) -> None:
    os.mkfifo(workspace / "evil.md")
    snap = snapshot(repo(workspace))  # would block forever with a plain open()
    assert any(i.path == "evil.md" and i.code == "not_a_file" for i in snap.issues)
    assert snap.get("SEM-ARCH-001") is not None


@pytest.mark.skipif(os.name == "nt", reason="symlinks need privileges on Windows")
def test_symlink_swapped_in_after_scan_is_not_followed(workspace: Path, tmp_path: Path) -> None:
    outside = write_doc(
        tmp_path / "outside", "secret.md", make_doc("OUT-2", body="# S\n\nSWAP-MARKER text long enough.")
    )
    r = repo(workspace)
    target = workspace / "SEM-ARCH-001.md"
    target.unlink()
    target.symlink_to(outside)
    issues: list = []  # type: ignore[type-arg]
    assert r._load_file(target, issues) is None  # direct open refuses the symlink (O_NOFOLLOW)
    assert issues and issues[0].code == "read_error"
