---
name: knowledge-quality-review
description: Review the SKH knowledge base for duplicate ids, broken or dangling links, stale revisions, conflicting assertions between documents and missing required fields, and produce a findings list with fixes. Use before a release, after bulk document changes, or when answers look inconsistent.
---

# Knowledge quality review

**Purpose.** Catch defects that make search or answers wrong before users do.

**When to use.** Periodic review; after many document edits; when two answers disagree; before a
deploy of a new corpus.

**Inputs.** Knowledge root (default `fixtures/knowledge`), optionally a subset of ids.

## Procedure
1. **Structural checks.** `make mock-kb-validate` → duplicate ids, unknown relation targets,
   self-relations, invalid `version`, missing `synthetic`, required chains, secret-like strings.
2. **Load issues at runtime.** `GET /api/knowledge/issues` (files rejected by the running index) and
   `GET /api/graph/diagnostics` (dangling edges, orphans).
3. **Stale revisions.** Compare `reviewed_at`/`version` of documents that `depends_on` each other: a
   dependant reviewed before its dependency changed is a candidate for review, not an auto-fix.
4. **Conflicting assertions.** For key facts (thresholds, owners, refresh schedules, codes), `rg` the
   value across documents; the same subject with different values in two `approved` docs is a
   conflict. Report both with scope/revision; do not pick a winner.
5. **Status hygiene.** `deprecated` docs must have a successor via `supersedes`; `draft` must not be
   cited by approved docs as the authority.
6. **Report.** One line per finding: severity, id(s), evidence (file:line), proposed fix.

## Validation commands
```bash
make mock-kb-validate && jq '.errors, .warnings | length' reports/knowledge-eval/validation.json
cd backend && ../.venv/bin/python -m pytest tests/test_knowledge_base.py::test_synthetic_base_is_valid_and_connected -q
```

## Expected outputs
Findings list (possibly empty) with evidence; zero validation errors after fixes.

## Constraints
Review proposes; it does not approve, deprecate or delete on its own — that is a human decision
through a proposal. Synthetic data only.

## Example (checkable)
`fixtures/knowledge_updates/conflict/` adds a second file with an existing id; case `KE-SY-008`
(`sync_duplicate_id`) expects it quarantined (`rejected: duplicate_id`), never guessed or cited. For
scope differences that are not contradictions see `KE-GOV-010` (95 % general vs 98 % dataset threshold).
