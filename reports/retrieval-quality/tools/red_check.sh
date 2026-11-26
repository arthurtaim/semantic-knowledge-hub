#!/usr/bin/env bash
# RED check: run the retrieval-v2 regression tests against the code BEFORE the change, to prove they catch the old
# errors. Creates a temporary detached worktree of BASE (default f4ea26e) outside the repository, copies the new tests
# into it with a small shim (v2-only symbols → v1 behaviour), runs them, prints PASSED/FAILED per test, removes the
# worktree. Nothing in the working copy is modified.
#
#   reports/retrieval-quality/tools/red_check.sh [BASE] > reports/retrieval-quality/evidence/red_check_v1.log
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
BASE=${1:-f4ea26e}
WT=$(mktemp -d "${TMPDIR:-/tmp}/skh-redcheck.XXXXXX")
PY="$ROOT/.venv/bin/python"
cleanup() { git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true; git -C "$ROOT" worktree prune; }
trap cleanup EXIT
git -C "$ROOT" worktree add --detach "$WT" "$BASE" >/dev/null 2>&1
"$PY" - "$ROOT" "$WT" <<'EOF'
import sys
from pathlib import Path
root, wt = Path(sys.argv[1]), Path(sys.argv[2])
src = (root / "backend/tests/test_retrieval_quality.py").read_text(encoding="utf-8")
shim = '''
# --- RED-check shim: these tests run against the code BEFORE retrieval v2 ---
import app.domain.text as _text
from app.services import assistant as _assistant
MAX_QUERY_TERMS = _text.MAX_QUERY_TERMS
def fleeting_vowel_stem(word):  # absent before v2
    return None
def local_insufficiency(passages, terms, matched, *, frequency=None, eligible=0):
    return _assistant.local_insufficiency(passages, terms, matched)
class retrieval_trace:  # absent before v2: the tool did not exist, so it could not refuse anything
    @staticmethod
    def main(argv):
        return 0
'''
for old, new in (
    ("from app.domain.text import MAX_QUERY_TERMS, analyze_query, fleeting_vowel_stem, term_matches_text, tokenize",
     "from app.domain.text import analyze_query, term_matches_text, tokenize"),
    ("from app.evaluation import retrieval_trace\n", ""),
    ("from app.services.assistant import local_insufficiency\n", ""),
    ("from tests.conftest import make_doc\n", "from tests.conftest import make_doc\n" + shim),
):
    assert old in src, old
    src = src.replace(old, new, 1)
(wt / "backend/tests/test_retrieval_quality_red.py").write_text(src, encoding="utf-8")
(wt / "backend/tests/test_external_rag_red.py").write_text(
    (root / "backend/tests/test_external_rag.py").read_text(encoding="utf-8"), encoding="utf-8"
)
EOF
echo "# RED check of the retrieval-v2 tests against $BASE ($(git -C "$ROOT" rev-parse "$BASE")), $(date -u +%FT%TZ)"
cd "$WT/backend"
"$PY" -m pytest -p no:cacheprovider -q -rA \
  tests/test_retrieval_quality_red.py \
  "tests/test_external_rag_red.py::test_topical_local_documents_without_the_asked_value_consult_the_external_source" \
  "tests/test_external_rag_red.py::test_local_only_never_calls_the_external_source" \
  "tests/test_external_rag_red.py::test_sufficient_local_evidence_makes_no_external_call" 2>&1 \
  | grep -E "^(PASSED|FAILED) |^=+ .* in [0-9.]+s" || true
