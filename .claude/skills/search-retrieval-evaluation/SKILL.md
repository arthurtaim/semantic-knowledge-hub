---
name: search-retrieval-evaluation
description: Measure SKH search/retrieval quality on the fixed gold set before and after a change (dictionary, weights, tokenizer, ranking, graph expansion) and write a comparison report. Use whenever retrieval code, search_dictionary/dictionary.yaml or index weights change.
---

# Search and retrieval evaluation

**Purpose.** Changes to retrieval are accepted only with numbers from the same cases before and after.

**When to use.** Editing `backend/app/services/retrieval.py`, `backend/app/domain/text.py`,
`backend/app/search_dictionary/dictionary.yaml`, FTS weights in
`backend/app/adapters/search/sqlite_fts.py`, assistant context selection.

**Inputs.** The change, the hypothesis ("synonym X should rank Y first"), the categories it affects.

## Procedure
1. **Baseline on the current commit** (before editing):
   ```bash
   cd backend && ../.venv/bin/python -m app.evaluation.knowledge_eval --kb ../fixtures/knowledge \
     --cases ../fixtures/eval --label baseline --out ../reports/knowledge-eval
   ```
2. **Write/adjust gold cases first** for the behaviour you want (`fixtures/eval/cases_*.yaml`).
   Never edit or tune on cases marked `holdout: true`.
3. **Change** the code or dictionary (dictionary label changes `v1:<sha>`).
4. **After:** `make knowledge-eval` (label `after`, same cases).
5. **Compare** Recall@1, Recall@5, MRR, leaks (draft/deprecated/restricted in results), `context_ok`,
   latency, per category; list cases that flipped PASS↔FAIL with the reason.
6. **Report** in `reports/knowledge-eval/comparison.md`; a regression in any category needs an
   explicit justification or a revert.

## Validation commands
```bash
make knowledge-eval
cd backend && ../.venv/bin/python -m pytest tests/test_knowledge_base.py -q
```

## Expected outputs
`reports/knowledge-eval/{baseline,after}.json`, `metrics.csv`, `failures.md`, `comparison.md`; zero
leaks; holdout results reported separately. The command exits non-zero while any case fails (the reports
are still written). A red baseline is normal input for a comparison. Never mask the exit code or weaken a
case to turn it green; the known failures and their causes are in `reports/knowledge-eval/failures.md`.

## Constraints
Deterministic eval (mock AI, no network) is the acceptance basis. Live eval
(`SKH_LIVE_EVAL=1 make knowledge-eval-live`) is opt-in, synthetic only, reported separately. Never
invent or round numbers in your favour; paste the command output.

## Example (checkable)
Gold case `KE-INTB-003` (`fixtures/eval/cases_integrations_b.yaml`): «линейдж датасета Process Overview
от ARIS» must return `DEMO-INT-014` in the top 3 — it depends on the dictionary group
линейдж ↔ lineage; removing that group must turn the case into a FAIL in the after report.
