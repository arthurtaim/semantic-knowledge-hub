# Acceptance and test plan

Must run tests locally or explain genuine environment blocker. Mock integrations for automated CI; never use bank production in test suites.

## Acceptance scenarios

| ID | Scenario | Expected outcome |
|---|---|---|
| AC-01 | Start with no credentials/network | UI/API boot; demo fixture documents available |
| AC-02 | Search `ARIS` | Synthetic ARIS fixture appears with title, status and source |
| AC-03 | Open document | Correct Markdown and owner/status/type/tags displayed; safe rendering |
| AC-04 | Search no matches | Explicit empty result, not fabricated documents |
| AC-05 | Ask documented demo fact | Mock returns only extractive evidence and clickable valid citation |
| AC-06 | Ask unsubstantiated real bank fact | Explicit insufficient evidence; no invented data flow |
| AC-07 | Ask while Confluence disabled | Answer limited to local docs; status says disconnected |
| AC-08 | Propose document change | Diff shown; original unchanged |
| AC-09 | Reject proposed change | Proposal status changes; original unchanged |
| AC-10 | Mark ready for review | Status changes only, not approved or merged |
| AC-11 | Invalid document path/ID | No path traversal or file read outside workspace |
| AC-12 | Invalid/duplicate frontmatter ID | Validation error, not ambiguous result |
| AC-13 | Stale base revision | Proposal submission or publication blocked with conflict |
| AC-14 | Markdown XSS payload | Sanitized; no script execution |
| AC-15 | Prompt injection embedded in source | Does not override system workflow or call privileged tools |
| AC-16 | GitLab/Confluence credentials missing | Status shows disabled; no hidden network requests |
| AC-17 | GitLab simulated HTTP errors | Clear 401/403/429/5xx handling; no tokens in logs |
| AC-18 | Confluence simulated access denied | Restricted document not in search response, citation or model context |
| AC-19 | GitLab vs GitHub separation | No real knowledge/content in application repo or CI logs |
| AC-20 | Offline build/test | No reliance on external LLM services at runtime |

## Unit tests
- Frontmatter parse / invalid YAML / schema strictness / stable IDs.
- Markdown sanitize and links.
- Rebuild/search ranking, source filters and archived/draft exclusion.
- Citation check against actual retrieved sources.
- Proposal diff, mutation safety, revision hashes.
- Configuration and provider selection.

## Integration tests (all mocks)
- FastAPI routes and response validation.
- Mock GitLab API list/read/MR branch creation with error handling.
- Mock Confluence MCP tool discovery and search/read with ACL/scope, timeouts.
- Internal AI API response validation with mocked transport; reject model-produced fake citations.
- Future publisher handles Confluence version increment, conflict, repeat idempotence.

## UI tests
- Search, open/read, Ask response, citation click, propose/diff, integration unavailable states.
- Navigation keyboard usability, phone-width layout and loading/error feedback.

## Security verification
- `git ls-files` does not include `.env`, private workspaces, real data, tokens.
- Non-loopback production deployment with `AUTH_MODE=local_demo` fails safe.
- Untrusted Markdown/XSS, prompt injection, path traversal, SSRF and ACL negative cases.

## Demonstration
At delivery, run the local app and walk through AC-01 to AC-10. Report exact test command output, not an unverified claim.

## Traceability: implemented tests

| ID | Automated evidence |
|---|---|
| AC-01 | `backend/tests/test_api_knowledge.py::test_document_list_contains_fixtures`, `frontend/e2e/smoke.spec.ts` (AC-01..AC-04) |
| AC-02 | `test_api_knowledge.py::test_search_aris`, e2e AC-01..AC-04 |
| AC-03 | `test_api_knowledge.py::test_document_detail`, `frontend/src/__tests__/document.test.tsx` |
| AC-04 | `test_api_knowledge.py::test_search_no_matches_is_empty`, `explorer.test.tsx`, e2e |
| AC-05 | `test_assistant.py::test_documented_fact_returns_extractive_evidence`, `test_curated_qa.py`, e2e AC-05..AC-07 |
| AC-06 | `test_assistant.py::test_unsupported_bank_fact_is_insufficient`, `::test_aris_flow_is_not_invented`, `test_curated_qa.py` |
| AC-07 | `test_assistant.py::test_corporate_scope_disabled_is_disclosed`, `ask.test.tsx`, e2e |
| AC-08 | `test_drafts.py::test_create_draft_shows_diff_and_keeps_source`, `proposal.test.tsx`, e2e AC-08..AC-10 |
| AC-09 | `test_drafts.py::test_reject_keeps_source`, e2e |
| AC-10 | `test_drafts.py::test_mark_ready_changes_status_only`, e2e |
| AC-11 | `test_repository.py::test_symlinks_never_followed`, `::test_get_document_rejects_path_like_ids`, `test_api_knowledge.py::test_path_traversal_attempts` |
| AC-12 | `test_schema_markdown.py` (duplicate keys, invalid enums/IDs), `test_api_knowledge.py::test_duplicate_id_is_validation_error`, `test_gitlab.py::test_invalid_and_duplicate_documents_are_reported` |
| AC-13 | `test_drafts.py::test_stale_base_revision_on_create`, `::test_source_change_after_draft_blocks_mark_ready`, `test_gitlab.py::test_publisher_refuses_stale_base_revision` |
| AC-14 | `test_schema_markdown.py::test_xss_payloads_are_neutralized`, `test_api_knowledge.py::test_xss_document_is_sanitized`, `document.test.tsx` (DOMPurify) |
| AC-15 | `test_assistant.py::test_prompt_injection_in_source_is_treated_as_data`, `::test_injection_text_is_delimited_for_models` |
| AC-16 | `test_api_knowledge.py::test_integration_status_offline_defaults`, autouse socket block in `conftest.py`, `test_config_security.py` |
| AC-17 | `test_gitlab.py::test_http_errors_are_mapped_without_leaking_token`, `::test_transient_errors_are_retried_with_bound`, `::test_gitlab_outage_returns_503` |
| AC-18 | `test_assistant.py::test_corporate_mock_respects_acl`, `test_confluence_mcp.py::test_search_filters_spaces_and_validates_links`, `::test_assistant_uses_only_authorized_corporate_pages` |
| AC-19 | `test_repo_hygiene.py` (ignored paths, no secrets/PII in candidate files, synthetic fixture markers, empty secrets in `.env.example`) |
| AC-20 | Whole pytest suite runs with outbound sockets blocked; Docker backend runs on an `internal: true` network |

Integration readiness (M4): `test_gitlab.py` — keyset/offset tree pagination, branch probe, undocumented branch/commit/MR responses resolved by state, POST never retried; `test_confluence_mcp.py` — session close (`DELETE`), `tools/list` cursor pagination, result-field mapping and relative links; `tests/integration/test_confluence_mcp_replay.py` — replayable server scenarios from `fixtures/integration/confluence_mcp/*.json` (JSON and SSE); `test_integration_config.py` — secrets from files, CA bundles, offline `app.preflight`; `tests/live/` — opt-in read-only smoke (skipped unless `SKH_LIVE_TESTS=1`).

Other contract tests: internal AI adapter with mocked transport (`test_assistant.py`: request shape, HTTP errors, timeout, size limit, misconfiguration, fake citations rejected), MCP tool discovery without guessed names and SSE replies (`test_confluence_mcp.py`), idempotent MR creation (`test_gitlab.py`). M5 publisher tests (version increment, conflict, repeat) are implemented since v0.3 — see the M4.6/M4/M5 section below.

## M4.5: browser scenarios E2E-01…E2E-12

`make e2e` runs the offline stack scenarios (`desktop`/`mobile`, against `make up`) and starts a second, loopback-only stack for `@gitlab` scenarios: the GitLab TEST DOUBLE (`backend/tests/support/gitlab_mock.py`), a backend with `KNOWLEDGE_BACKEND=gitlab` (`frontend/e2e/gitlab-stack.sh`) and Vite on :5175. A passing `@gitlab` scenario proves the application flow against the mock, **not** a real GitLab.

| ID | Scenario | Test |
|---|---|---|
| E2E-01 | Home: search, assistant entry, sections, recent docs, proposals, sources | `e2e/scenarios.spec.ts` |
| E2E-02 | Search, sorting by date, empty result | `scenarios.spec.ts`, `smoke.spec.ts` (AC-01..04) |
| E2E-03 | Document with metadata, revision, related docs, no fake source link | `scenarios.spec.ts` |
| E2E-04 | Answer with a verified citation (demo mode, Ctrl+Enter) | `scenarios.spec.ts`, `smoke.spec.ts` (AC-05..07) |
| E2E-05 | No evidence → «Недостаточно данных» | `scenarios.spec.ts` |
| E2E-06 | Create a proposal; the source stays unchanged | `scenarios.spec.ts`, `smoke.spec.ts` (AC-08..10) |
| E2E-07 | Diff: line view and before/after | `scenarios.spec.ts` |
| E2E-08 | Revision conflict: nothing overwritten, proposal kept, recreate link | `e2e/gitlab.spec.ts` (@gitlab) |
| E2E-09 | Submit → branch/commit/MR → merge in GitLab → «Проверить статус» → KB updated | `gitlab.spec.ts` (@gitlab) |
| E2E-10 | GitLab 503 on commit → «Ошибка отправки», proposal kept, retry → exactly one MR | `gitlab.spec.ts` (@gitlab) |
| E2E-11 | Confluence MCP configured but unreachable: status «Ошибка», answer discloses it | `gitlab.spec.ts` (@gitlab) |
| E2E-12 | Phone layout: no horizontal scroll on main pages, menu works | `scenarios.spec.ts`, `smoke.spec.ts` (@mobile) |

## M4.5: backend coverage

- `tests/test_gitlab_lifecycle.py` (stateful GitLab mock, in-process via `httpx.ASGITransport` with a client timeout): commit revisions, dates and revision links; head-probe skips the tree walk; only changed files re-read and re-indexed; deleted documents leave catalog and index; history reads; partial sync failure keeps the last version flagged `stale`; outage serves the last snapshot flagged `stale`; revoked token drops the cache; full lifecycle to `merged` with KB update and MR description content; no duplicate MR on resubmit; commit applied but answer lost → detected, not repeated; commit timeout without write → safe retry; MR created but answer lost → adopted; uncertain MR outcome blocks local reject until checked; conflicts at mark-ready, at submit and in the race between check and commit (GitLab `last_commit_id`); permission error; foreign branch never overwritten; MR closed → rejected; invariant: zero writes to the protected branch in every scenario.
- `tests/test_authz.py`: every route declares one action; write routes map to write actions; `DenyAllPolicy` → 403 on every route; corporate scope needs `read_corporate`; local demo policy only for the demo identity on loopback; SSO mode refuses to start.
- `tests/test_knowledge_rules.py`: incremental FTS index (revision tracking, removal, single entry per document, restart), sorting, honest local revisions, `/api/index/*`, path rules, validation (front matter, id change, size, path), migration of v0.1 proposal stores, `http` only for loopback, `APP_PUBLIC_URL` rules, OpenAPI contract.
- Frontend (Vitest, 46 tests): lifecycle states (ready, submission_failed incl. uncertain, conflict, submitted, merged), submit error reload, explorer sorting and dates, home blocks and empty states, document source link vs local, re-sync button, API error states.

## M4.6 / M4 / M5: scenarios E2E-13…E2E-36

Evidence levels (never mixed up in reports):

- **pytest API-level end-to-end** — the real FastAPI app in-process against the stateful TEST DOUBLES
  (`backend/tests/support/gitlab_mock.py`, `confluence_mock.py`, `mcp_mock.py` through `httpx.ASGITransport`
  with a client-side timeout; outbound sockets are blocked).
- **Docker `make mock-e2e`** — `backend/tests/support/mock_scenario.py` runs inside the `integration_mock`
  network against the real backend container and the doubles (needs `make mock-up`). Steps: integration
  labels → new document draft → review → GitLab MR → merge in the double → sync + FTS → dry-run without
  writes → create page → approved update (same page, version 2) → manual edit → conflict → corporate answer
  via MCP with provenance.
- **Vitest** — component tests of the UI with a mocked API (`frontend/src/__tests__/authoring.test.tsx`).
- **Vitest (publication)** — `frontend/src/__tests__/publication.test.tsx`: document publication block, job
  page (create preview and publish, publishing never offered while writes are off, update with versions,
  manual-edit acknowledgement after confirmation, «Проверить результат» first for unconfirmed writes,
  `409 plan_changed`, `503`), merged-pending-sync notice, integration labels.
- **Browser (Playwright)** — `frontend/e2e/authoring.spec.ts` (E2E-13…22; offline stack, `@mobile`, and
  `@gitlab` for E2E-18/19/20) and `frontend/e2e/publication.spec.ts` (`@gitlab`: E2E-23…28, 31, 33, 36) on
  the loopback `integration_mock` stack started by Playwright (GitLab, MCP and Confluence DC doubles,
  `frontend/e2e/gitlab-stack.sh`). Scenarios without a browser spec are marked «—». Pass/fail numbers of the
  latest run are recorded in `README.md`, not here.

Passing any of these proves the application flow against the doubles, **not** real GitLab or Confluence.

Abbreviations: `A` = `backend/tests/test_authoring.py`, `G` = `backend/tests/test_gitlab_create.py`,
`P` = `backend/tests/test_publications.py`, `S` = `backend/tests/test_confluence_storage.py`,
`I` = `backend/tests/test_integration_profiles.py`; browser specs: `AS` = `frontend/e2e/authoring.spec.ts`, `PS` = `frontend/e2e/publication.spec.ts`.

| ID | Scenario | pytest (API-level, doubles) | `make mock-e2e` | Vitest (`authoring.test.tsx` for 13–21, `publication.test.tsx` for 23–34) | Browser (Playwright) |
|---|---|---|---|---|---|
| E2E-13 | Manual creation of a document | `A::test_check_generates_frontmatter_and_safe_preview`, `A::test_new_document_draft_is_persistent_and_not_in_the_catalog` | step «Новый документ … черновик» | «saves with POST, switches the URL to the draft and saves again with PUT» | `AS` «E2E-13/14/15 manual document from a template…» |
| E2E-14 | Template choice and expected structure | `A::test_five_templates_with_required_structure_and_free_ids` | uses the `architecture` skeleton | «lists templates with sections and opens the editor prefilled» | `AS` «E2E-13/14/15 …» |
| E2E-15 | Persistent draft after restart | `A::test_new_document_draft_is_persistent_and_not_in_the_catalog` (new app process, same workspace) | — (no container restart in the scenario) | «restores the form from the server and deletes the draft only after confirmation» | `AS` «E2E-13/14/15 … persistent draft, reload» |
| E2E-16 | Duplicate ID/path blocked without losing text | `A::test_duplicate_id_or_path_is_blocked`, `A::test_unsafe_path_and_mismatched_filename_are_errors`, `A::test_save_draft_with_optimistic_versioning` | — | «keeps the text and shows the error on the ID field when the ID is taken (409)», «keeps the local text on a lost update (409 draft_modified)» | `AS` «E2E-16 duplicate ID is blocked and the text is kept» |
| E2E-17 | Proposal → ready for review | `A::test_ready_draft_is_no_longer_editable_and_errors_block_review`, `G::test_create_conflict_detected_at_mark_ready` | step «Ревью → ветка …» | «marks a clean draft ready for review…», «blocks review while validation reports errors» | `AS` «E2E-17 draft → «Готово к ревью»; the new-file diff adds everything» |
| E2E-18 | GitLab mock: branch → `create` commit → MR | `G::test_create_lifecycle_until_knowledge_sync` | step «Ревью → ветка + create-коммит + MR» | «shows the operation, new-file wording, a fully added diff» | `AS` `@gitlab` «E2E-18/19/20 …» |
| E2E-19 | Resubmit creates no second MR | `G::test_create_lifecycle_until_knowledge_sync` (repeat refused, one MR), `G::test_lost_answer_of_create_commit_is_reconciled_without_duplicates`, `G::test_lost_answer_of_mr_creation_then_retry_creates_exactly_one_mr` | — | — | `AS` `@gitlab` «E2E-18/19/20 …» |
| E2E-20 | Only confirmed merge + sync adds the document to KB and FTS | `G::test_create_lifecycle_until_knowledge_sync`, `G::test_unmerged_new_document_never_enters_the_knowledge_base`, `G::test_merge_without_successful_sync_is_not_reported_as_in_the_knowledge_base`, `G::test_create_conflict_when_the_path_appears_before_submit` | step «… merge в GitLab-дубле → синхронизация» (catalog 404 before, FTS hit after) | «shows the knowledge-base revision after a confirmed merge» | `AS` `@gitlab` «E2E-18/19/20 … merge → in the knowledge base» |
| E2E-21 | Demo AI invents nothing, admits missing data | `A::test_ai_draft_follows_template_and_quotes_only_verified_sources`, `A::test_ai_draft_admits_insufficient_data`, `A::test_ai_draft_cannot_be_approved`, `A::test_ai_draft_unavailable_when_ai_is_disabled` | — | «fills the body from the demo helper and shows sources, quotes and the insufficient-data notice», «keeps the request when the AI helper is unavailable» | `AS` «E2E-21 demo AI quotes approved sources and admits missing data» |
| E2E-22 | Editor usable on mobile | — | — | — | `AS` `@mobile` «E2E-22 the editor is usable on a phone» |
| E2E-23 | Merged + synced document → persistent publication job | `P::test_merge_creates_durable_job_with_read_only_dry_run_then_one_page`, `P::test_restart_keeps_jobs_mapping_and_flags_interrupted_writes` | step «Задание публикации создано после merge» | — | `PS` `@gitlab` «E2E-23/24/25/26/27 …» |
| E2E-24 | Dry-run returns a preview and does not write | `P::test_merge_creates_durable_job_with_read_only_dry_run_then_one_page` (0 writes, GET only), `P::test_write_disabled_by_default_allows_only_dry_run` | step «dry-run без записи в Confluence» (write counter unchanged) | «shows a create preview and publishes it» | `PS` `@gitlab` «E2E-23/24/25/26/27 … dry-run without writes …» |
| E2E-25 | First publication creates exactly one page | `P::test_merge_creates_durable_job_with_read_only_dry_run_then_one_page` | step «Публикация: создана одна страница с меткой владельца» | «shows a create preview and publishes it» | `PS` `@gitlab` «E2E-23/24/25/26/27 … page created …» |
| E2E-26 | Next approved change updates the same page and version | `P::test_next_change_updates_same_page_and_repeat_is_idempotent` | step «Утверждённое изменение → та же страница, версия 2» | «describes an update with versions and blocks publishing on problems» | `PS` `@gitlab` «E2E-23/24/25/26/27 … updated …» |
| E2E-27 | Idempotent repeat: no duplicate, no extra version | `P::test_next_change_updates_same_page_and_repeat_is_idempotent` (`noop`) | — | — | `PS` `@gitlab` «E2E-23/24/25/26/27 … repeat is a no-op» |
| E2E-28 | Manual edit in Confluence → conflict, no overwrite | `P::test_manual_edit_is_a_conflict_and_never_overwritten` (incl. acknowledge → explicit publish) | step «Ручная правка в Confluence → конфликт» | «explains a manual edit and acknowledges it only after confirmation» | `PS` `@gitlab` «E2E-28 manual edit in Confluence → conflict…» |
| E2E-29 | 401/403 → clear error, consistent state | `P::test_forbidden_write_fails_clearly_and_keeps_gitlab_merge`, `P::test_rejected_token_during_dry_run_is_reported` | — | — | — |
| E2E-30 | Server unavailable → job persists, merge intact | `P::test_unavailable_confluence_keeps_job_and_merge` | — | «keeps the page usable when Confluence is unavailable (503)» | — |
| E2E-31 | Timeout after a successful write → reconciliation, no blind retry | `P::test_lost_answer_after_create_is_reconciled_without_duplicate`, `P::test_lost_answer_with_failed_inspection_becomes_result_unknown`, `P::test_unexpected_error_during_write_never_leaves_job_publishing` | — | «checks an unconfirmed write before anything else» | `PS` `@gitlab` «E2E-31 lost answer after a successful create…» |
| E2E-32 | Restart keeps job and mapping | `P::test_restart_keeps_jobs_mapping_and_flags_interrupted_writes` | — | — | — |
| E2E-33 | Unmerged revision cannot be published | `P::test_unmerged_revision_cannot_be_published`, `P::test_not_publishable_status` | — | — | `PS` `@gitlab` «E2E-33/36 unmerged revision and a foreign page…» |
| E2E-34 | Real Confluence write off by default; mock-only writes gated | `P::test_write_disabled_by_default_allows_only_dry_run`, `P::test_publication_disabled_without_rest_url`, `I::test_publish_write_refused_outside_mock_and_staging`, `I::test_publish_write_to_mock_allowed_only_for_declared_double`, `I::test_staging_write_needs_ack_and_corporate_ca` | integration labels step (`target=mock`, `access=read_write`) | «never offers publishing while writes are disabled and explains why», «says that only a preview is possible when writes are off» | — |
| E2E-35 | Storage output for supported Markdown; unsupported constructs reported | `S` (all five tests) | — | — | — (unit level) |
| E2E-36 | Unknown/foreign page ID can never be overwritten | `P::test_page_with_same_title_but_no_marker_is_a_conflict`, `P::test_tampered_mapping_to_a_foreign_page_is_refused`, `P::test_frontmatter_page_id_is_ignored`, `P::test_no_route_accepts_a_page_id` | — | — | `PS` `@gitlab` «E2E-33/36 …» |

Every pytest scenario against the GitLab double also asserts the global invariant «zero writes to the
protected branch» (fixture teardown).

### Unit, contract and configuration coverage (M4.6 / M4 / M5)

- **Templates and authoring** (`test_authoring.py`): five templates and their sections, suggested IDs skip
  documents and unfinished proposals, YAML-serialized front matter (no injection through the title), safe
  preview (no `<script>`/`javascript:`), unsafe path / filename ≠ ID, optimistic versioning (`409
  draft_modified`), editing locked after review, delete, editing `update` drafts, demo AI (template order,
  verified quotes with revision, «Недостаточно данных», no `approved`, disabled provider → `503`).
- **GitLab `create`** (`test_gitlab_create.py`): `create` commit with `Operation: create`, one MR, path
  conflict before submit and at mark-ready, lost answers of commit and MR, closed MR → `rejected`,
  `merged_pending_sync` and retry. `test_gitlab_lifecycle.py` keeps the M4.5 `update` lifecycle.
- **MCP contract on the stateful double** (`test_mcp_mock_contract.py`): `tools/list` pagination and session
  close, mapped results with provenance (JSON and SSE replies), non-allowlisted spaces dropped, new page
  versions, explicit `mcp_tool_missing` / `mcp_tool_schema_mismatch` / `mcp_auth_failed` / `mcp_http_error`
  / `mcp_invalid_response` / `mcp_rpc_error` / `mcp_timeout`, tool error on read → not found, assistant cites
  corporate pages with provenance. Replay scenarios: `tests/integration/test_confluence_mcp_replay.py`.
- **Publication** (`test_publications.py`): see the table; plus one active job per document enforced by the
  store, honest integration labels (`target`/`access`/`checked_at`), the publishing token never appears in
  logs or responses.
- **Storage format** (`test_confluence_storage.py`): supported elements, escaping (incl. CDATA), unsafe links
  block, unsupported constructs → warnings with visible placeholders, signature ignores re-serialisation.
- **Run modes** (`test_integration_profiles.py`): offline default, `MOCK_SERVICE_HOSTS` restrictions,
  `integration_mock` addresses only declared doubles, `live_*` need `https`, `live_read_only` forbids writes,
  publisher needs complete separate configuration (space, parent, own token ≠ MCP token, GitLab backend, no
  credentials in URL), staging write needs ACK + CA.
- **Authorization** (`test_authz.py`): every route declares exactly one action; `DenyAllPolicy` refuses all
  routes (incl. authoring and publication). The explicit write-route table does not yet list the new
  authoring/publication routes.

### How to run

```bash
make check                                   # lint + typecheck + pytest + vitest (offline)
cd backend && ../.venv/bin/python -m pytest tests/test_authoring.py tests/test_gitlab_create.py \
  tests/test_publications.py tests/test_confluence_storage.py tests/test_integration_profiles.py \
  tests/test_mcp_mock_contract.py            # only the M4.6/M4/M5 suites
make mock-up && make mock-e2e && make mock-readiness && make mock-down   # Docker, integration_mock profile
make e2e                                     # Playwright: E2E-01…12 and the browser specs of E2E-13…36
```

Results of the latest run are recorded in `README.md` («Последний прогон») by the lead engineer.
