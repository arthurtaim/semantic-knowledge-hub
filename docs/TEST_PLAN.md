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

Other contract tests: internal AI adapter with mocked transport (`test_assistant.py`: request shape, HTTP errors, timeout, size limit, misconfiguration, fake citations rejected), MCP tool discovery without guessed names and SSE replies (`test_confluence_mcp.py`), idempotent MR creation (`test_gitlab.py`). M5 publisher tests (version increment, conflict, repeat) remain open because publication is not implemented.

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
