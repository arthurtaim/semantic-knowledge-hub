# Knowledge graph

The graph is a read model of **declared** relations, rebuilt for every index generation
(`app/services/graph.py`). It never infers a fact edge from text or a model.

## Nodes and edges

Nodes: team documents (with type and status), templates, and — only in an answer's query graph —
external Confluence pages.

Edges come from frontmatter:

| Field | Relation |
|---|---|
| `relations.depends_on` / `consumes` / `produces` / `maps_to` / `derived_from` / `describes` / `constrains` / `supersedes` | typed edge of that kind |
| `relations.uses_template`, `template` | document → template |
| `related_ids` (not already typed) | `references` |

Every edge has `origin` and provenance:

| Origin | Fact? | Source |
|---|---|---|
| `canonical_metadata` | yes | frontmatter of `declared_in`, `field`, `path`, `revision` |
| `verified_registry` | yes | template registry |
| `query_trace` | no, temporary | which sources one answer used |
| `external_discovery` | no, temporary | external page found for a question |
| `ai_suggestion` | no | never written into documents |

A relation to an id that does not exist is not an edge: it is listed by `GET /api/graph/diagnostics` as
dangling (with the declaring document), together with orphans.

## Views and limits

Node ids are namespaced: `doc:<document id>`, `template:<template id>`, external pages in query graphs.

| View | API | Limits |
|---|---|---|
| Global | `GET /api/graph/overview?limit=&kind=&relation=&status=&type=&q=` | ≤ 200 nodes (default 150), most connected first |
| Local | `GET /api/graph/nodes/{id}/neighbors?depth=&relation=&limit=&cursor=` | depth ≤ 2, ≤ 200 per page, cursor paging |
| Path | `GET /api/graph/path?source=&target=&max_depth=&directed=` | ≤ 6 hops |
| Query | `GET /api/graph/query/{trace_id}` | the sources of one answer; expires with the trace |
| Legend | `GET /api/graph/legend` | node kinds, relation and origin labels, limits |

Nodes carry their status and can be filtered by it (`status=`); deprecated nodes are shown with their
status by default (`deprecated=false` hides them). A draft node is never presented as approved.
External nodes in a query graph are re-validated on every read (ACL, version, deleted); when a page is
gone or restricted, the node is dropped and the trace invalidated.

The UI is `/graph` (Global / Local / Query); every answer has a «Граф ответа» link.

The map («Карта знаний», `docs/ui-v2/specs/04_KNOWLEDGE_GRAPH.md`) is drawn on the client from these
responses without changing them: the whole base is a force layout grouped by node kind (`kindRegions`: plain
documents in the middle, source systems, integrations, entities, datasets and templates in regions around them;
`forceX` / `forceY` towards the region, links between two kinds pull less), a neighbourhood and an answer graph
are radial (focus or question in the centre, depth / cited sources on the first ring), unlinked nodes sit in a
ring at the edge (`frontend/src/lib/graph.ts`, synchronous and deterministic). Nodes can be dragged; the
manual positions are a per-view overlay kept in `sessionStorage` (`lib/graphPositions.ts`), never sent to the
server, and «Сбросить расположение» drops them.

On the whole base («Вся база») an edge is almost transparent until one of its nodes is hovered or selected
(then it is drawn dark with its relation's name; unconfirmed edges stay dashed), and only the 15 most connected
nodes, the selected and the hovered node and their neighbours are named (`labelRank`; a label that would
collide is hidden by the priority selected > hovered > neighbours > degree, the full name stays in the node's
tooltip and accessible name). A neighbourhood and an answer graph keep their edges and, up to 40 nodes, name
every node where there is room. The legend is one line by default (the swatches of the kinds on the map) and
expands on demand; the choice is kept in `localStorage`. The graph generation is shown in «Сведения об узле»
while nothing is selected and in the tooltip of «N узлов, M связей».

## Checks

```bash
make mock-kb-validate     # ≥ 100 edges, 6 required lineage chains are paths
cd backend && ../.venv/bin/python -m pytest tests/test_sync_and_graph.py -q
make knowledge-eval       # graph_neighbors / graph_path cases, graph-after-sync scenarios
```

The graph is cached per (generation, template registry); a sync that adds, changes or removes a relation
produces a new graph — an old edge after a sync is a bug.
