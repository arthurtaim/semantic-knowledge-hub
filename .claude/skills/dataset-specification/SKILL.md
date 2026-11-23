---
name: dataset-specification
description: Write or review a synthetic dataset specification in SKH using the dataset template (attributes, sources, mapping, quality rules, refresh, lineage, access restrictions) with typed relations to its sources and integrations. Use when a dataset document is created or changed.
---

# Dataset specification

**Purpose.** A dataset document that an analyst can trust: what each attribute means, where it comes
from, how it is checked and refreshed, who may use it.

**When to use.** New `type: dataset` document; adding attributes; changing refresh or DQ rules.

**Inputs.** Dataset name, source systems/documents, consuming integrations, owner.

## Procedure
1. **Template.** Use `dataset_spec` (`backend/app/document_templates/dataset.md`, current version from
   `GET /api/authoring/templates`); set `template: dataset_spec`, `template_version`.
2. **Attributes.** Table: name, meaning, type, required, allowed values, source field.
3. **Sources and mapping.** For every attribute, the source document id and field; declare
   `relations: derived_from: [DEMO-SRC-…]` and `maps_to:` for semantic entities.
4. **Quality rules.** Each rule with a threshold and the governance doc that owns it
   (`constrains` edge from `DEMO-GOV-…`).
5. **Refresh.** Schedule, trigger, latency; producing integration (`produces` on the integration side).
6. **Lineage.** Source → integration → dataset → consumers, consistent with the graph path
   (`GET /api/graph/path?source=doc:<src>&target=doc:<dataset>`).
7. **Restrictions.** Access class, PII flags (synthetic), retention.
8. **Validate** (below), then add a gold case for one attribute fact.

## Validation commands
```bash
cd backend && ../.venv/bin/python -m pytest tests/test_authoring.py::test_templates_with_required_structure_and_free_ids -q
make mock-kb-validate && make knowledge-eval
```

## Expected outputs
`POST /api/authoring/check` reports no missing required sections; the lineage path exists in the graph.

## Constraints
Synthetic attributes and systems only; no real schema exports or table names from the bank.

## Example (checkable)
Required chain `DEMO-SRC-005 → DEMO-INT-007 → DEMO-SEM-006 → DEMO-SEM-011` (kb_validate
REQUIRED_CHAINS) is the lineage a dataset spec must agree with.
