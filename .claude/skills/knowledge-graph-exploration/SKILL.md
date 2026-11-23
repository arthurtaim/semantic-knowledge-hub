---
name: knowledge-graph-exploration
description: Explore and verify the SKH knowledge graph — canonical typed edges with provenance, global/local/query subgraphs, suggested vs declared edges, and ACL/TTL/generation behaviour. Use when changing backend/app/services/graph.py, the graph API, the Graph Explorer UI, or when checking that relations in documents produce the expected edges.
---

# Knowledge graph exploration

**Purpose.** The graph is a projection of declared frontmatter relations for one index generation
(`docs/KNOWLEDGE_GRAPH.md`); every edge must be explainable by its provenance.

**When to use.** Graph code or UI changes; a relation looks missing or wrong; checking a lineage chain;
reviewing what the assistant's answer graph shows.

**Inputs.** Document id(s), relation types of interest, an answer `retrieval_trace_id` (query mode).

## Procedure
1. **Canonical edges.** `GET /api/graph/nodes/doc:<id>/neighbors?depth=1` → each edge has `type` (the relation),
   `origin` (`canonical_metadata`, `verified_registry`, `external_discovery`, `query_trace`,
   `ai_suggestion`), `verified`, and provenance (`declared_in`, `field`, `path`, `revision`). Only
   `canonical_metadata` / `verified_registry` edges are facts.
2. **Verify provenance.** Open the `declared_in` file and find the relation in its frontmatter; a
   mismatch is a bug.
3. **Views.** Global: `GET /api/graph/overview?limit=200` (capped at 200 nodes). Local:
   neighbours, depth ≤ 2. Path: `GET /api/graph/path?source=doc:A&target=doc:B` (≤ 6 hops).
   Query: `GET /api/graph/query/<trace_id>`. UI: `/graph` (Global / Local / Query tabs).
4. **Suggested / temporary.** `query_trace`, `external_discovery` and `ai_suggestion` edges are drawn
   as temporary/unverified, never written into documents and never shown as declared.
5. **ACL / TTL / generation.** After a sync the graph is rebuilt for the new generation; restricted
   external nodes are re-validated and dropped; expired traces disappear. Dangling targets go to
   `GET /api/graph/diagnostics`.

## Validation commands
```bash
cd backend && ../.venv/bin/python -m pytest tests/test_sync_and_graph.py -q -k graph
make mock-kb-validate      # ≥100 edges and 6 required chains
make e2e                   # e2e/graph.spec.ts when the UI changed
```

## Expected outputs
Edges with provenance; overview ≤ 200 nodes; required chains are paths; no restricted node in any view.

## Constraints
Relations are declared by people in frontmatter — never inferred by a model and never added to a
document automatically. Read-only exploration.

## Example (checkable)
`tests/test_sync_and_graph.py::test_required_chain_is_a_path` and
`::test_local_graph_shows_provenance_of_every_edge`.
