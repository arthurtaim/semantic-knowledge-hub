# Search, index sync and versioned templates

## One snapshot, one generation

`KnowledgeRepository` (local folder or GitLab) produces one snapshot of validated documents. The search
index (`app/adapters/search/sqlite_fts.py`) applies it in **one SQLite transaction** and gets a new,
monotonic `generation`. Everything users see — catalog, facets, search, the graph, the assistant's
context — is read from that generation, so a change is visible everywhere at once or nowhere.

The manifest table `doc_versions` (doc_id, source, revision, path, fingerprint, indexed_at, generation)
lets an incremental sync classify every file:

| Result | Meaning |
|---|---|
| `added` | new id |
| `updated` | same id, different content fingerprint (new revision) |
| `renamed` | same id and content, different path |
| `deleted` | id no longer in the snapshot |
| `rejected` | invalid frontmatter, duplicate id, unsafe path — quarantined, never guessed |

`POST /api/index/sync` returns these lists plus `generation`, `checksum`, `elapsed_ms`;
`GET /api/index/status` shows the last result, the dictionary label and the template-registry label.
`?rebuild=true` drops and rebuilds the derived index; the checksum must equal the incremental one
(`tests/test_sync_and_graph.py::test_full_rebuild_equals_incremental`). If applying fails, the transaction
rolls back and the previous generation keeps serving.

## Retrieval pipeline

`app/services/retrieval.py`, used by catalog search, `/api/search` and the assistant:

1. **Query analysis** (`app/domain/text.py`): normalisation, RU stemming, stopwords; identifiers
   (`DEMO_VALIDATION_LIMIT`, `owner_role_code`) are kept as exact phrases; stems of ≤3 characters match
   whole tokens only.
2. **Dictionary** (`app/search_dictionary/dictionary.yaml`, label `v1:<sha>`): synonym groups
   (линейдж ↔ lineage ↔ происхождение данных), abbreviations; ambiguous ones (ADR, MDM) add a note
   instead of guessing.
3. **Exact id** → top tier; **exact title / alias** → next tier; query is a title phrase → bonus.
4. **FTS5** with column weights (id 10, title 8, aliases 6, tags 4, related 1, summary 2, headings 3,
   body 1): AND of all terms; if nothing, OR at half weight.
5. Title-term and tag bonuses; deprecated ×0.6 in the catalog; status filters before ranking
   (draft/in_review/deprecated are not evidence by default).
6. **Bounded graph expansion**: up to 5 typed neighbours of the direct hits, placed after them and marked
   `related_via`.
7. Every hit carries `match_reasons` (human readable) and `matched_fields` (`id`, `title`, `alias`,
   `tags`, `content`, `related`).

Embeddings, a vector DB or an LLM re-ranker are not used.

**Assistant passages** (`RetrievalService.passages`, also `knowledge_search`): the best sections of the best eligible
documents, one per document first. A section whose every line is corpus-wide boilerplate — a body line repeated in
≥ 5 documents and > 5 % of the reader's snapshot (`RetrievalService.boilerplate`, cached per snapshot; e.g. the banner
every synthetic document opens with) — is skipped for the next section of the same document: it matched many words
and, being short, outranked content, so the model received disclaimers instead of evidence. Document ranking and the
FTS index are unchanged. A follow-up question is pre-retrieved by its own words and together with the previous
question, merged round-robin (`AssistantService._prepare`).

Eval case fields for the assistant (`app/evaluation/knowledge_eval.py`): `history` (earlier questions of a
follow-up), `expect_provenance` (`AskResponse.provenance.overall`), `max_warnings`, `unmatched_only_current`,
`context_any` (one of the documents must be in the context given to the model) — besides `expected_doc_ids`,
`cited_any`, `facts_required`, `facts_forbidden`, `not_cited`, `warning_contains`, `expected_excluded`.

Changing the dictionary or the weights requires a before/after `make knowledge-eval` on the same cases;
holdout cases are never used for tuning (skill `search-retrieval-evaluation`).

## Versioned templates

Templates are files in `backend/app/document_templates/<id>.md`; older versions stay in
`history/<id>.v<N>.md`. `TemplateRegistry` (`app/domain/template_registry.py`) loads them into the
`template_versions` table on start and on every sync:

- a new file → a new template, visible in `GET /api/authoring/templates` without a code change;
- a changed file with a higher `version` → a new version for new drafts;
- a changed file **without** a version bump → detected by checksum and registered as a new version
  (and logged: it should have been bumped);
- `listed: false` hides a template from the picker (`external_import`).

A draft stores `template_version` and is validated against that version; the UI shows a notice when a
newer one exists. Nothing is migrated silently. Shipped: `integration` v2 (v1 in history),
`dataset_spec` v1, `external_import` v1 (hidden), plus the earlier templates.

## Commands

```bash
make mock-kb-validate     # fixtures: schema, links, ≥100 edges, required chains, synthetic, secrets
make mock-kb-sync         # fixtures → ./workspace/knowledge (only files it owns)
make knowledge-eval       # 216 deterministic gold cases incl. sync, template, provenance and follow-up cases
```
