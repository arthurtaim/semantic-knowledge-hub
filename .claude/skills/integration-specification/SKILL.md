---
name: integration-specification
description: Write or review a synthetic integration (data flow) specification in SKH with the integration template v2 — source/target, payload and metadata, constraints, error handling, monitoring and lineage — and declare consumes/produces/depends_on relations. Use when an integration document is created or changed.
---

# Integration specification

**Purpose.** Describe one data flow so that its lineage, failure behaviour and owners are explicit and
the graph shows it correctly.

**When to use.** New `type: integration` document; changing payload, schedule, error handling;
re-pointing a flow to another source.

**Inputs.** Source system/doc, target dataset/entity, transport, owner, schedule.

## Procedure
1. **Template.** `integration` current version (v2) from `GET /api/authoring/templates`; old drafts stay on v1
   (`history/integration.v1.md`) — don't migrate them silently.
2. **Source/target.** `relations: consumes: [DEMO-SRC-…]`, `produces: [DEMO-SEM-…/dataset]`,
   `depends_on:` for upstream integrations.
3. **Payload and metadata.** Fields, keys, change-detection (full/incremental/CDC), volume.
4. **Constraints.** Ordering, idempotency, windows, governance rules that apply (`constrains` from
   `DEMO-GOV-…`).
5. **Error handling.** Retry policy, dead-letter, who is alerted, what users see.
6. **Monitoring and lineage.** Metrics; path source → integration → target in the graph.
7. **Validate**, add a gold case for one error-handling or schedule fact.

## Validation commands
```bash
cd backend && ../.venv/bin/python -m pytest tests/test_authoring.py tests/test_template_registry.py -q
make mock-kb-validate && make knowledge-eval
```

## Expected outputs
No missing required sections for v2; `GET /api/graph/nodes/doc:<id>/neighbors` shows consumes/produces.

## Constraints
Synthetic systems, hosts and queues only; no real endpoints, credentials or internal URLs.

## Example (checkable)
`DEMO-INT-001` (ARIS ingestion) — `consumes: [DEMO-SRC-002]`, `produces: [DEMO-SRC-007]`,
`supersedes: [DEMO-INT-018]`; part of the required chain `DEMO-SRC-002 → … → DEMO-INT-015`.
