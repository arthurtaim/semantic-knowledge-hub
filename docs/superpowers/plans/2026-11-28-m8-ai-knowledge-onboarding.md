# M8 — AI Knowledge Onboarding — Implementation Plan

> Executed inline (owner: «implement, do not stop after planning»). Spec: owner package
> `SKH_M8_AI_Knowledge_Onboarding_Implementation/` (not committed). Branch `feature/m8-ai-knowledge-onboarding` from
> `main` `be76afd`. Owner rule: few test runs — targeted tests per task, one `make check`, targeted E2E.

**Goal:** a ZIP / folder / multi-file upload becomes a staged, reviewable batch; the person edits AI/heuristic
suggestions and confirms selected files as ordinary DRAFT proposals; canonical knowledge changes only through the
existing review → GitLab merge → sync.

**Reuse (no second lifecycle):** `MetadataService.import_preview` (per-file metadata, template, tags, related with
evidence, YAML validation), `ProposalService.create_new_document` / `create_imported` (CREATE drafts, idempotent by
`client_request_id`) and `ProposalService.create` (UPDATE of an existing document with `base_revision`, gains an
optional `client_request_id`), `attachments.extract` (PDF / DOCX text, zip-bomb guard), `api/multipart.read_form`
(bounded streaming upload), `extract_wikilinks`, authz `Action.create_proposal`, app-state SQLite.

## Decisions

- Storage: `onboarding_batches`, `onboarding_items`, `onboarding_confirmations` in the app-state SQLite
  (`app/services/onboarding/store.py`); extracted TEXT only (no raw files on disk, opaque ids, no client file names as
  paths); TTL 72 h, purge on access; cancel deletes staged text.
- Limits (config `ONBOARDING_*`): upload 20 MB, expanded 100 MB, 200 files, 10 MB per file (and the authoring
  document limit for text), ratio 50, path depth 8, nested archives refused.
- Analysis is deterministic and synchronous at upload (bounded); AI enrichment is a separate explicit, bounded step
  (`POST …/suggest`, ≤ 10 items per call) — model output is a suggestion with a verified evidence quote or dropped.
- Duplicates: exact hash in batch (later = duplicate, skipped by default), same YAML ID in batch (conflict, one
  must be excluded), ID of an existing document (UPDATE via the change workflow; identical content = duplicate of
  existing), open create draft with the same ID/path (conflict), same title as an existing document (advisory).
- Links: WikiLinks / YAML `related_ids` / ID mentions → `CandidateLink` {kind, target, resolve_state
  resolved|in_batch|missing|ambiguous, evidence {file, line, snippet}, selected_by_user=false,
  bound_to_entity_graph=false}; only user-selected candidates enter `related_ids` of the draft.
- Confirm: expected batch revision + preview fingerprint + selected ids + idempotency key; per-item deterministic
  outcomes stored durably; per-item `client_request_id = onb-<batch>-<item>` so a crash/retry never duplicates a
  draft; stale target revision → item `draft_failed` (`revision_conflict`) / 409 for the whole call when the
  fingerprint is stale.
- UI: `/documents/onboarding` (stepper Загрузка → Анализ → Проверка → Создание черновиков), `?batch=` resume, links
  from «Импорт» and «Документы».

## Tasks

1. Store + limits + safe archive/folder ingestion + parsers (md/txt/pdf/docx) + analysis (reuse import_preview) +
   duplicates + links; `POST/GET /api/onboarding/batches…`, capabilities, cancel. Tests: OB-01, 03–08, 12, 16, 18–21.
2. Item decisions (PATCH with expected_revision), preview (fingerprint), confirm (idempotent, per-item outcomes,
   UPDATE path), `ProposalService.create` client_request_id. Tests: OB-09, 13–15, 22, concurrency.
3. AI enrichment protocol (vendor-neutral, verified quotes) + providers + scripted double; `POST …/suggest`.
   Tests: OB-10, OB-11.
4. GitLab lifecycle test (OB-17) on the GitLab test double: confirm → submit → merge → sync → search/graph.
5. Frontend page + client + types + links; vitest.
6. E2E (scripted stack) happy + negative; docs (`docs/KNOWLEDGE_ONBOARDING.md`, API v0.11, ADR-050, user guide,
   README/DEVELOPMENT/docs index); one `make check`, `knowledge-eval`; report.
