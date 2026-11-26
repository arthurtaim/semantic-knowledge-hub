# Evidence (synthetic only, sanitized)

Local absolute paths are replaced by `<repo>` / `<tmp>`; server output of the E2E test stack is removed from `e2e.log`.
No secrets, no real documents, no databases.

| File | What |
|---|---|
| `before_run.log`, `run1_after_run.log`, `after_run.log` | full 216-case runs: baseline on `f4ea26e`; final run 1 (the single blind holdout run); final run 2 (after the E2E-driven rule, identical per case) |
| `make_knowledge_eval.log`, `make_check.log`, `make_mock_kb_validate.log`, `make_work_eval.log`, `e2e.log`, `vitest_rerun.log` | the regression gate on the final code (`04_TEST_RESULTS.md`) |
| `tuning_manifest.txt` | the 184 tuning case ids (no holdout) and source file hashes |
| `before_traces.json` | stage-by-stage traces of the 6 tuning failures on the baseline (`app.evaluation.retrieval_trace`) |
| `probes_before_traces.json` | traces of 4 probe failures on the baseline |
| `after_holdout_traces.json` | post-freeze diagnosis of 3 holdout cases (`--allow-holdout`); no code change was made from it |
| `df_external_tuning_cases.txt` | document frequency of question words for the non-holdout external cases and probes (data of the 10 % rule) |
| `bench_search_{before,after}_run{1,2}.json` | `/api/search` and catalog latency (`reports/knowledge-eval/bench_search.py`) |
| `bench_assistant_{before,after}_run{1..4}.json` | `/api/assistant/ask` latency and external (MCP) calls per case (`tools/bench_assistant.py`); after runs 1–2: frozen code of run 1, runs 3–4: final code |
| `citation_audit_{before,after}.json` | independent audit of every citation (`tools/citation_audit.py`) |
| `red_check_v1.log` | the new tests run against `f4ea26e` (`tools/red_check.sh`) |
