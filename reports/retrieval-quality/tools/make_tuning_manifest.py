"""Build the TUNING-ONLY case manifest: every case of fixtures/eval without `holdout: true`.

The original suite is not modified. The manifest is written OUTSIDE fixtures/eval (a temporary path given by the
caller) as one YAML list in the exact format `knowledge_eval.load_cases` reads; the selected ids and the hashes of
the source files are written next to it, so the selection is checkable and reproducible:

    .venv/bin/python reports/retrieval-quality/tools/make_tuning_manifest.py \
        --cases fixtures/eval --out "$TMPDIR/skh-tuning/cases_tuning.yaml" \
        --ids reports/retrieval-quality/evidence/tuning_manifest.txt

Holdout cases are excluded by their own `holdout` flag, never by a remembered list of ids.
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

import yaml


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--ids", type=Path, required=True)
    args = parser.parse_args()
    files = sorted(args.cases.glob("*.yaml"))
    tuning: list[dict] = []
    holdout: list[str] = []
    lines = [
        "# Tuning manifest: fixtures/eval cases WITHOUT holdout: true",
        "# source files (sha256/16):",
    ]
    for file in files:
        raw = file.read_bytes()
        lines.append(f"#   {file.name} {hashlib.sha256(raw).hexdigest()[:16]}")
        for case in yaml.safe_load(raw) or []:
            if case.get("holdout") is True:
                holdout.append(str(case["case_id"]))
            else:
                tuning.append(case)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    text = yaml.safe_dump(tuning, allow_unicode=True, sort_keys=False)
    args.out.write_text(text, encoding="utf-8")
    lines.append(
        f"# manifest sha256/16: {hashlib.sha256(text.encode()).hexdigest()[:16]}"
    )
    lines.append(
        f"# tuning cases: {len(tuning)}; holdout cases excluded: {len(holdout)}"
    )
    lines += [str(c["case_id"]) for c in tuning]
    args.ids.parent.mkdir(parents=True, exist_ok=True)
    args.ids.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"tuning={len(tuning)} holdout_excluded={len(holdout)} -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
