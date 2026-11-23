---
name: document-update-and-sync
description: Change, rename or delete an SKH knowledge document and prove that catalog, FTS index, facets, graph and assistant context all moved to one new index generation — including a negative test that the old term is gone and a rollback check. Use for any edit to fixtures/knowledge or a workspace knowledge root.
---

# Document update and sync

**Purpose.** Keep the invariant "one knowledge snapshot, consistent projections"
(`docs/SEARCH_SYNC_TEMPLATES.md`): after a change, no stale term, edge or citation survives.

**When to use.** Editing a rule/value in a document, bumping its version, changing relations,
renaming a file, deprecating or deleting a document.

**Inputs.** Document id(s), the intended change, the reason.

## Procedure
1. **Diff first.** Show the change (`git diff` or a proposal diff). Keep `id`. A rename changes the
   path only; the index reports it as `renamed`, not delete + add.
2. **Version / status.** Content change → bump `version` (MINOR for clarification, MAJOR for a changed
   rule). Superseding → old doc `status: deprecated` + `relations: supersedes:` on the new one.
   Never set `approved` on behalf of a reviewer.
3. **Sync.** Local workspace: `make mock-kb-sync` then `POST /api/index/sync`; tests use their own temp
   copy. The result lists `added/updated/renamed/deleted/rejected`, `generation`, `checksum`.
4. **Negative test.** Search the OLD value/term: it must not return the document (and the assistant
   must not cite it). Search the NEW value: found, with the new revision.
5. **Graph.** `GET /api/graph/nodes/doc:<id>/neighbors` reflects the new relations; removed targets show up
   in `/api/graph/diagnostics` as dangling, never as silent edges.
6. **Rollback check.** An invalid file is `rejected` and the previous generation keeps serving
   (`tests/test_sync_and_graph.py::test_failed_sync_rolls_back_to_the_previous_generation`).

## Validation commands
```bash
make mock-kb-validate
cd backend && ../.venv/bin/python -m pytest tests/test_sync_and_graph.py tests/test_kb_sync_tool.py -q
make knowledge-eval        # lifecycle scenarios KE-SY-* exercise add/update/rename/delete
```

## Expected outputs
`IndexSyncResult` with the exact counts you expect; generation +1; full rebuild checksum equals the
incremental one (`test_full_rebuild_equals_incremental`); stale-term search returns nothing.

## Constraints
Synthetic data only. `make mock-kb-sync` never overwrites a file edited locally (reported as a
conflict) and never touches files it did not write. Do not edit server volumes by hand.

## Example (checkable)
`fixtures/knowledge_updates/update/` changes `DEMO_VALIDATION_LIMIT` 7 → 11; case `KE-SY-003`
(`sync_update_rule`) in `fixtures/eval/cases_lifecycle.yaml` asserts the new value is found and cited
with the new revision and the old one is gone; `KE-SY-007` covers rename, `KE-SY-006` delete.
