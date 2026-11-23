# Mutable synthetic snapshots for lifecycle experiments (M5.6.2 Appendix 1 §6, Appendix 3 §5)

`base/` is a small, fixed synthetic knowledge base. Each scenario of `app.evaluation.scenarios` copies it
into a TEMPORARY workspace, applies one overlay and runs a sync — the curated base (`fixtures/knowledge`),
a developer's workspace and any server volume are never touched.

| Overlay | Change |
|---|---|
| `add/` | new approved DEMO-TEST-NEW-001 (field `SYNTHETIC_Q7_FIELD`) with a valid `depends_on` edge |
| `add_draft/` | new draft DEMO-TEST-DRAFT-001 |
| `update/` | DEMO-TEST-REV-001: `DEMO_VALIDATION_LIMIT` 7 → 11, version 1.0 → 2.0, a unique old word removed |
| `update_relation/` | DEMO-TEST-MAP-001: `maps_to` DEMO-TEST-SEM-009 → DEMO-TEST-SEM-010 |
| `update_meta/` | DEMO-TEST-SEM-010: approved → deprecated, owner changed |
| `invalid/` | a file with broken YAML |
| `conflict/` | a second file with the id DEMO-TEST-REV-001 |
| (scenario) delete | DEMO-TEST-DEL-001 removed: DEMO-TEST-REF-001 keeps a dangling link |
| (scenario) rename | `a/DEMO-TEST-MOVE-001.md` → `b/DEMO-TEST-MOVE-001.md`, same id and content |

Everything is fictional; `DEMO_VALIDATION_LIMIT` and `SYNTHETIC_Q7_FIELD` exist only here.
