"""Synchronise the synthetic fixture base into a local workspace (make mock-kb-sync).

`seed_from_fixtures` only seeds an EMPTY workspace. This tool keeps an existing demo workspace in step with
`fixtures/knowledge` without ever touching what it does not own:

- a manifest (`.skh-fixtures-manifest.json`, hidden, ignored by the scanner) lists the files this tool
  wrote and their sha256;
- new fixture files are added; a managed file is updated only if its content still equals what the tool
  wrote last time (a local edit is reported as a conflict and kept); a managed file whose fixture was
  removed is deleted only under the same condition;
- files the tool did not write are never modified or deleted.

The running backend picks the change up on its next refresh (or POST /api/index/sync). Writes are atomic
(temp file + rename). Dry run by default prints the plan; `--apply` executes it.

    python -m app.tools.kb_sync --fixtures ../fixtures/knowledge --workspace ../workspace/knowledge [--apply]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

MANIFEST = ".skh-fixtures-manifest.json"


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@dataclass
class Plan:
    add: list[str] = field(default_factory=list)
    update: list[str] = field(default_factory=list)
    delete: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)  # managed files edited locally: kept as they are
    adopt: list[str] = field(default_factory=list)  # identical unmanaged files: start managing them

    def summary(self) -> dict[str, int | list[str]]:
        return {
            "add": len(self.add),
            "update": len(self.update),
            "delete": len(self.delete),
            "unchanged": len(self.unchanged),
            "adopt": len(self.adopt),
            "conflicts": self.conflicts,
        }


def _fixture_files(root: Path) -> dict[str, Path]:
    files: dict[str, Path] = {}
    for path in sorted(root.rglob("*.md")):
        if path.is_symlink() or any(part.startswith(".") for part in path.relative_to(root).parts):
            continue
        files[path.relative_to(root).as_posix()] = path
    return files


def plan(fixtures: Path, workspace: Path) -> tuple[Plan, dict[str, str]]:
    manifest_path = workspace / MANIFEST
    manifest: dict[str, str] = (
        json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else {}
    )
    result = Plan()
    wanted = _fixture_files(fixtures)
    for rel, source in wanted.items():
        target = workspace / rel
        source_sha = _sha(source)
        if not target.exists():
            result.add.append(rel)
        elif rel not in manifest:
            if _sha(target) == source_sha:
                result.adopt.append(rel)
            else:
                result.conflicts.append(rel)  # an unmanaged file with the same name: never overwritten
        elif _sha(target) != manifest[rel]:
            result.conflicts.append(rel)  # edited in the workspace since the last sync
        elif source_sha != manifest[rel]:
            result.update.append(rel)
        else:
            result.unchanged.append(rel)
    for rel, written_sha in manifest.items():
        if rel in wanted:
            continue
        target = workspace / rel
        if not target.exists():
            continue
        if _sha(target) == written_sha:
            result.delete.append(rel)
        else:
            result.conflicts.append(rel)
    return result, manifest


def _atomic_copy(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.tmp")
    tmp.write_bytes(source.read_bytes())
    os.replace(tmp, target)


def apply(fixtures: Path, workspace: Path) -> Plan:
    result, manifest = plan(fixtures, workspace)
    wanted = _fixture_files(fixtures)
    for rel in [*result.add, *result.update]:
        _atomic_copy(wanted[rel], workspace / rel)
        manifest[rel] = _sha(wanted[rel])
    for rel in result.adopt:
        manifest[rel] = _sha(wanted[rel])
    for rel in result.delete:
        (workspace / rel).unlink()
        manifest.pop(rel, None)
    for rel in [r for r in list(manifest) if r not in wanted and not (workspace / r).exists()]:
        manifest.pop(rel)
    workspace.mkdir(parents=True, exist_ok=True)
    tmp = workspace / f"{MANIFEST}.tmp"
    tmp.write_text(json.dumps(dict(sorted(manifest.items())), indent=1), encoding="utf-8")
    os.replace(tmp, workspace / MANIFEST)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Synchronise synthetic fixtures into a demo workspace.")
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--apply", action="store_true", help="execute the plan (default: dry run)")
    args = parser.parse_args(argv)
    fixtures, workspace = args.fixtures.resolve(), args.workspace.resolve()
    if not fixtures.is_dir():
        print(f"fixtures not found: {fixtures}", file=sys.stderr)
        return 2
    result = apply(fixtures, workspace) if args.apply else plan(fixtures, workspace)[0]
    print(json.dumps({"applied": args.apply, **result.summary()}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
