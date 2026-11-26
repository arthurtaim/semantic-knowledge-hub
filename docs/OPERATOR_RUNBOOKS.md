# Operator runbooks

Short procedures for the people who run an SKH instance. Commands assume the repository root and a
stack at `$SKH` (e.g. `http://127.0.0.1:8000` locally, the UI port on a compose stack). On the demo
stacks the API needs no login; on a corporate stack use your session.

## 1. Add a document and check that the index found it

1. Put the Markdown file into the knowledge root (corporate: merge an MR into the GitLab knowledge
   repository; demo: `fixtures/knowledge/…` then `make mock-kb-sync`).
2. Sync: `curl -s -X POST "$SKH/api/index/sync" | jq '.last_sync'` — the id must be in `added`, not in
   `rejected` (if rejected, `code` says why: `duplicate_id`, `outside_root`, a schema error such as a
   missing required field, …).
3. Find it: `curl -s "$SKH/api/search?q=<a word from its title>" | jq '.items[].id'` and open
   `/documents/<id>` in the UI.
4. Graph: `curl -s "$SKH/api/graph/nodes/doc:<id>/neighbors" | jq '.edges[] | {type, source, target, origin}'`.

## 2. Update a document with a version and links

1. Edit the content, bump `version` (MINOR: clarification, MAJOR: changed rule), keep `id`.
2. Changed relations go into `relations:` / `related_ids`; a replacement is `status: deprecated` on the
   old document plus `supersedes:` on the new one.
3. Sync (as above): the id is in `updated` (or `renamed` if only the path changed).
4. Negative check: search the old value — the document must not come back for it; ask the assistant —
   the citation shows the new revision.

## 3. Add a template and check the UI

1. New file `backend/app/document_templates/<id>.md` (frontmatter `template_id`, `title`, `doc_type`,
   `id_prefix`, `version: 1`; body = the `##` sections).
   For a new version of an existing template, first copy the current file to `history/<id>.v<N>.md`.
2. Restart the backend or sync; `curl -s "$SKH/api/authoring/templates" | jq '.[] | {id, version}'`.
3. UI: «Создать документ» lists the template; an old draft created from the previous version shows a
   notice and keeps its version.

## 4. Which instructions produced an answer

Every answer carries `instructions_version`, `index_generation` and `retrieval_trace_id`.

```bash
curl -s "$SKH/api/assistant/instructions" | jq           # current files, versions, fallback flag
curl -s "$SKH/api/index/status" | jq '{generation, search_dictionary, template_registry}'
```

A version starting with `fallback-` means a runtime instruction file was missing or invalid and the
built-in safe policy was used — fix the file (see `docs/ASSISTANT_INSTRUCTIONS.md`) and restart.
`GET /api/graph/query/<retrieval_trace_id>` shows the sources that answer used.

## 5. Run the evaluation and roll back a bad index generation

```bash
make mock-kb-validate     # structure of the synthetic base
make knowledge-eval       # 216 deterministic cases → reports/knowledge-eval/after.json, after_failures.md
```

`make knowledge-eval` exits non-zero when any case does not pass (fail, error or unsupported). The reports are
written first in either case. The current known failures and their causes are listed in
`reports/knowledge-eval/failures.md`.

The index is derived data — a "bad generation" is fixed by fixing its input, never by editing SQLite:

- **A bad document change** (wrong values, broken links): revert it in the source (GitLab revert MR;
  demo: `git checkout` the file or `make mock-kb-sync`), then `POST /api/index/sync`. The new generation
  has the previous checksum again.
- **A failed sync** (invalid file, error while applying): nothing to do — the transaction is rolled
  back and the previous generation keeps serving; the bad file is listed in `rejected` and in
  `GET /api/knowledge/issues`.
- **A suspected corrupt index**: `POST /api/index/sync?rebuild=true` rebuilds it from the snapshot;
  the checksum must equal the one before.
- **External evidence gone stale**: `DELETE /api/discovery` purges discovery memory and the page cache.

## 6. Import a Markdown file without metadata (M5.6.3)

1. UI «Импорт» (or `POST /api/documents/import/preview {"content": "…"}`): check the generated ID, the
   suggested template and its reasons, fill the owner; suggested tags/related are kept only if you keep them.
2. «Создать черновик» → a draft (origin `import`) → usual review and merge. Files already lying in the
   knowledge root without YAML are listed by `GET /api/documents/import/staging`; they are not searchable or
   cited until a reviewed document replaces them.

## 7. Repair broken links

`GET /api/links/diagnostics` lists unresolved WikiLinks: `missing` (target deleted or not visible),
`title_link` / `ambiguous_title` (written by title, with candidates). Fix through a change proposal: replace
with `[[ID|название]]` chosen from the candidates; never point a link at a lookalike document.
