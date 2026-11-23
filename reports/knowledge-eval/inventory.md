# Synthetic knowledge base inventory (from `make mock-kb-validate`)

Documents: **83** (9 core SEM-* + 74 DEMO-*); edges: **291** (85 typed + 206 references); unresolved references: 0.

| Type | Count |
|---|---|
| architecture | 1 |
| dataset | 3 |
| decision | 5 |
| domain | 9 |
| glossary | 2 |
| guide | 5 |
| integration | 19 |
| overview | 1 |
| process | 7 |
| source | 12 |
| standard | 19 |

| Status | Count |
|---|---|
| approved | 73 |
| deprecated | 3 |
| draft | 3 |
| in_review | 4 |

| Relation | Edges |
|---|---|
| constrains | 7 |
| consumes | 8 |
| depends_on | 34 |
| derived_from | 7 |
| describes | 16 |
| maps_to | 4 |
| produces | 4 |
| references | 206 |
| supersedes | 2 |
| uses_template | 3 |

## Required lineage chains

- ok: DEMO-SRC-002 → DEMO-INT-001 → DEMO-INT-002 → DEMO-SEM-002 → DEMO-SEM-009 → DEMO-INT-015
- ok: DEMO-SRC-003 → DEMO-INT-004 → DEMO-INT-005 → DEMO-SEM-010
- ok: DEMO-SRC-005 → DEMO-INT-007 → DEMO-SEM-006 → DEMO-SEM-011
- ok: DEMO-GOV-003 → DEMO-INT-003 → DEMO-SEM-009
- ok: DEMO-GOV-009 → DEMO-GOV-001 → DEMO-GOV-011
- ok: DEMO-PROC-002 → DEMO-PROC-007 → DEMO-SEM-004 → DEMO-SEM-009

## Folders

| Folder | Documents |
|---|---|
| `.` | 9 |
| `decisions` | 4 |
| `governance` | 13 |
| `guides` | 5 |
| `integrations` | 18 |
| `processes` | 10 |
| `semantics` | 12 |
| `sources` | 12 |

## Synthetic Confluence corpus

`fixtures/confluence_mock/pages.yaml`: 24 pages (separate from the curated base; never imported).
