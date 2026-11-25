# M6 — Steps 1–2 progress: backend core and scheduling (24.11.2026)

Branch `feature/m6-native-work-management` from `77c753a` (worktree `semantic-knowledge-hub-m6`). Not pushed, not
merged, not deployed. Design and contracts: `docs/WORK_MANAGEMENT.md`, `docs/API_CONTRACTS.md` «v0.7».
Baseline audit: `reports/m6/BASELINE_AUDIT.md`.

## Commits

| SHA | Content |
|---|---|
| `abc7a32` | Step 0 audit, `.tasks/` ignored |
| `8cb73ec` | Step 1: `work.sqlite3` + versioned migrations, entities, identity gate, project/task API, archive, audit, idempotency, seed, `NativeTaskSystem`, `app.tools.work_db`; public overlay marks exposure. Verified on its own: ruff/format/mypy clean, `944 passed, 6 skipped` |
| `9a2081d` | Step 2: pure scheduler, dependencies API, Gantt snapshot, schedule preview/apply, `app.evaluation.work_bench` |
| `b95d597` | Typed frontend client (`api.work*`, types) for Step 3; no UI |
| (this commit) | docs: `WORK_MANAGEMENT.md`, API v0.7, RBAC rows, CLAUDE.md link, this report |

## Checks (real output, final tree)

```
$ cd backend && ../.venv/bin/python -m ruff check app claude_worker tests
All checks passed!
$ ../.venv/bin/python -m ruff format --check app claude_worker tests
225 files already formatted
$ ../.venv/bin/python -m mypy app claude_worker
Success: no issues found in 136 source files
$ ../.venv/bin/python -m pytest
983 passed, 6 skipped in 74.40s (0:01:14)          # baseline: 876 passed, 6 skipped
$ cd frontend && npx tsc --noEmit -p tsconfig.json   # exit 0
$ npx eslint .                                       # exit 0
$ npx vitest run
 Test Files  45 passed (45)
      Tests  563 passed (563)                        # baseline: 44 files, 559 tests
$ python -m app.evaluation.knowledge_eval --kb ../fixtures/knowledge --cases ../fixtures/eval --label after
cases 216 · passed 207 · failed 9 · R@1 0.9487 · R@5 0.9744 · MRR 0.9647 · leaks 0   (identical to before)
```

New tests: 107 backend (`test_work_calendar.py`, `test_work_scheduler.py`, `test_work_db.py`, `test_work_api.py`,
`test_work_schedule_api.py`) + 4 vitest (`workApi.test.ts`); two existing assertions changed on purpose
(`test_api_knowledge.py`: `task_system` is now the connected built-in module; session features gained
`work_management`). `make e2e` was not run: no UI exists yet (Step 3).

**Mutation spot check** (temporary code edits, reverted; work tests only): FS without `next_workday` → 6 failed;
`cycle_if_added` disabled → 2 failed; read-only mode allowing writes → 3 failed; locked successor ignored → 2 failed;
apply without plan-revision/hash checks → 2 failed. Optimistic locking is double-guarded (version check + CAS
`WHERE version = ?` inside `BEGIN IMMEDIATE`), so removing only one of them is not detected by design.

**Running process smoke** (backend via `uvicorn` on 127.0.0.1:8020, mock AI, separate work DB in the scratchpad):
migration v1 applied and demo seeded on first start (ARIS 14, DQI 10, RAG 8 tasks); create project/tasks; FS
dependency Fri→Mon `satisfied: true`; preview moved `SMOKE-1` and `SMOKE-2`; apply → `plan_revision` 5; replay with
the same `client_request_id` → `replayed: true`, revision still 5; `X-SKH-Exposure` write → 403; missing
`X-SKH-Client` → 403; foreign Host → 400. After stopping and restarting the process: same Gantt (revision 5, same
dates), no second migration, no second seed. Stack stopped afterwards.

## Performance (`python -m app.evaluation.work_bench`, service level, no HTTP)

Machine: macOS 26.5.2 arm64, Python 3.12.15. Synthetic project: chains of 10 tasks + cross edges.

| Operation | 200 tasks p50 / p95 | 1000 tasks p50 / p95 | 3000 tasks p50 / p95 |
|---|---|---|---|
| list 200 tasks | 2.6 / 2.8 ms | 11.6 / 15.8 ms | 35.8 / 42.3 ms |
| Gantt snapshot (all tasks) | 3.7 / 3.7 ms | 16.7 / 21.7 ms | 51.8 / 58.8 ms |
| schedule preview (chain shift) | 2.6 / 2.8 ms | 8.7 / 12.9 ms | 23.2 / 29.0 ms |
| preview + apply | 6.5 / 6.7 ms | 23.7 / 27.8 ms | 70.0 / 70.9 ms |
| edit one task | 1.5 / 1.7 ms | 4.9 / 5.1 ms | 13.7 / 18.8 ms |

Pure scheduler: a 1000-task chain (999 shifts) — the whole unit test call takes 0.03 s (`pytest --durations`). HTTP latency,
concurrent users and the Gantt UI with 200 tasks are not measured here (Step 3/6, staging).

## Scenario coverage (M6-xx → tests)

| ID | Status | Where |
|---|---|---|
| M6-01 | tested (API) | `test_m6_01_project_with_three_tasks_is_visible_in_every_view` |
| M6-02 | tested (API part; UI drag is Step 3) | `test_m6_02_status_moves_freely_and_list_sees_it` |
| M6-03 | tested (API part) | `test_m6_03_m6_04_apply_writes_atomically_and_every_view_agrees` |
| M6-04 | tested | scheduler `test_m6_04_…`, API `test_m6_04_m6_09_…` |
| M6-05 | tested | `test_m6_05_cycle_is_rejected_without_partial_writes`, scheduler `test_m6_05_…` |
| M6-06, M6-07 | tested | `test_m6_06_m6_07_self_and_cross_project_dependencies` |
| M6-08 | tested | `test_m6_08_m6_29_locked_successor_blocks_apply…`, scheduler `test_m6_08_…` |
| M6-09 | tested | calendar `test_m6_09_…`, scheduler, API |
| M6-10 | tested (API; diamond rendering is Step 3) | `test_m6_10_milestone_is_zero_duration_and_takes_part_in_fs` |
| M6-11, M6-12, M6-24, M6-34, M6-38 | not implemented (Step 4) | link table exists (`work_task_links`), no API |
| M6-13…M6-16, M6-33, M6-39 | not implemented (Step 5) | actions `propose_work`/`apply_work_proposal` exist |
| M6-17 | tested | API `test_m6_17_…`, two services/threads `test_m6_17_two_services_on_one_file…` |
| M6-18 | tested | `test_m6_18_failure_in_the_middle_of_apply_rolls_back_everything` |
| M6-19 | tested (server-side test identities) | `test_m6_19_m6_37_project_roles_with_server_side_identities` |
| M6-20 | tested | `test_m6_20_m6_35_public_exposure_is_read_only` (config and gateway header) |
| M6-21 | tested (TestClient + real process restart) | `test_m6_21_data_survives_a_restart`; smoke above |
| M6-22 | tested | `test_m6_22_seed_is_idempotent_and_never_touches_user_data` |
| M6-23 | not verified (UI, Step 3); backend Gantt 200/1000/3000 measured above | — |
| M6-25, M6-40 | tested (backend) | `test_m6_25_m6_40_work_module_needs_no_ai_and_no_integrations` |
| M6-26 | tested (backend: `last_day` vs `end_exclusive`, inclusive due) | calendar `test_m6_26_…`, API `test_m6_26_m6_27_…` |
| M6-27 | tested | API `test_m6_27_…` (×2), scheduler `test_m6_27_…` |
| M6-28 | tested | scheduler + API diamond tests |
| M6-29 | tested | scheduler + API locked-successor tests |
| M6-30 | tested | `test_m6_30_preview_writes_nothing` |
| M6-31 | tested | `test_m6_31_change_between_preview_and_apply_is_stale_and_rolls_back` |
| M6-32 | tested | `test_m6_32_double_apply_is_one_application` |
| M6-35 | tested | `test_m6_35_no_client_can_claim_another_actor_or_role`, `test_m6_20_m6_35_…` |
| M6-36 | tested (backend) | `test_m6_36_views_share_one_plan_revision_after_a_mutation` |
| M6-37 | tested (fake-but-server-side identity; real IdP absent) | `test_m6_19_m6_37_…`, `test_membership_mode_refuses_the_demo_operator` |

## Status labels

- **implemented + tested**: schema/migrations/backup/restore tool, project/task CRUD, hierarchy (4 levels), archive/
  restore, optimistic locking, idempotent create/apply, append-only audit + activity, identity gate (local operator,
  read-only exposure, membership with test identities), FS DAG, Gantt snapshot, preview/apply, demo seed,
  `NativeTaskSystem`, typed client.
- **not implemented (later steps)**: UI (3), task↔document links + graph projection (4), AI work proposals and
  `work_inspect` (5), `make work-eval`/E2E/docs for users (6), CPM critical path (P1), comments (P1), lag ≠ 0, SS/FF/SF.
- **not verified**: HTTP-level latency under concurrency, Gantt UI with 200 tasks, PostgreSQL port.
- **external blocker for team-ready**: no real identity provider / SSO; `AUTH_MODE=sso` refuses to start; member
  management API intentionally absent until a user directory exists. M6 is code-ready for a single local operator
  only; not team-ready.

## Deployment notes (nothing deployed)

`docker-compose.claude-public.yml` now sets `WORK_PUBLIC_EXPOSURE=true` for the backend and both
`deploy/claude-test/Caddyfile*` add `header_up X-SKH-Exposure public`. These are repository changes only; they take
effect only when the owner redeploys the personal test stack, and they can only restrict (M6 read-only on the public
link). Existing knowledge features are unaffected. The work database lives in the existing `workspace` volume; back it
up with `python -m app.tools.work_db backup` before any upgrade (see `docs/WORK_MANAGEMENT.md` §5).
