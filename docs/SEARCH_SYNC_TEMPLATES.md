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

1. **Query analysis** (`app/domain/text.py`): normalisation, RU stemming; identifiers
   (`DEMO_VALIDATION_LIMIT`, `owner_role_code`) are kept as exact phrases; stems of ≤3 characters match
   whole tokens only. Retrieval v2 (2026-11-26, `reports/README.md`): **function words** (stop words,
   prepositions, conjunctions, particles, pronouns such as «какими», «откуда», «который», auxiliary verbs —
   `FUNCTION_WORDS`) never become search terms, an acronym in capitals is kept; up to **16** content words per
   question (`MAX_QUERY_TERMS`; 12 cut the second part of long compound questions); a word with a **fleeting
   vowel** before its final consonant gets the stem of its other forms as an alternative spelling («попыток» →
   «попытк», «карточек» → «карточк», «недоступен» → «недоступн»; `fleeting_vowel_stem`, words of ≥ 6 letters).
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

**Assistant passages** (`RetrievalService.passages`, also `knowledge_search`) — **passage packing v2**. The context
documents are the ≤ 4 best eligible documents (ranking unchanged). Candidates are EVERY section of those documents that
contains a question word (v1: the 60 BM25-best sections of the whole corpus, so a relevant section of a context
document could be cut off by word-dense sections of other documents). A document the question names by its exact id
is the subject: its sections are packed first (both steps below), the other documents only take the slots left. Then:

1. one section per document, in document order: its BM25-best section (diversity);
2. the remaining slots (≤ 6 passages in all), one at a time: the section with the largest **gain** — the question
   words it adds to its OWN document's passages, each weighted by rarity in the eligible snapshot
   (`log((N+1)/(df+1)) + 1`); a word already shown from another document counts 0.5, one the document already shows
   counts 0.25 (corroboration); the sum is divided by (1 + document rank). Ties: the document with fewer passages,
   then rank, then BM25.

So a question whose parts are answered in different sections of the best document gets those sections (v1 always took
its two BM25-best — often short, word-dense «Пример» / «Назначение»). A section whose every line is corpus-wide
boilerplate — a body line repeated in ≥ 5 documents and > 5 % of the reader's snapshot (`RetrievalService.boilerplate`,
cached per snapshot; e.g. the banner every synthetic document opens with) — is never a candidate. Passages are
verbatim sections with their document id, anchor and revision; the order is deterministic. A follow-up question is
pre-retrieved by its own words and together with the previous question, merged round-robin
(`AssistantService._prepare`). Measured before/after and per-case flips: `reports/README.md`;
a developer trace of one case through every stage: `python -m app.evaluation.retrieval_trace` (refuses holdout cases).

Eval case fields for the assistant (`app/evaluation/knowledge_eval.py`): `history` (earlier questions of a
follow-up), `expect_provenance` (`AskResponse.provenance.overall`), `max_warnings`, `unmatched_only_current`,
`context_any` (one of the documents must be in the context given to the model) — besides `expected_doc_ids`,
`cited_any`, `facts_required`, `facts_forbidden`, `not_cited`, `warning_contains`, `expected_excluded`.

Changing the dictionary or the weights requires a before/after `make knowledge-eval` on the same cases;
holdout cases are never used for tuning (skill `search-retrieval-evaluation`).

Exit code: `python -m app.evaluation.knowledge_eval` returns 0 only when every selected case passes. It returns 1
when any case is `fail`, `error` or `unsupported`, or when no case was selected; `make knowledge-eval` then stops
with `Error 1`. `<label>.json`, `<label>_metrics.csv` and `<label>_failures.md` are written before the verdict,
so a red run keeps its evidence. A known failure is never hidden by an exit-code exception or a weakened case: it
stays red, with its cause in `reports/knowledge-eval/failures.md`, until the cause is fixed.

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
make knowledge-eval       # 216 deterministic gold cases incl. sync, template, provenance and follow-up cases;
                          # exit ≠ 0 if any case does not pass (reports are written first)
```
