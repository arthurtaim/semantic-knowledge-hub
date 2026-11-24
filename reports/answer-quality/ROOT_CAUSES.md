# Assistant answer quality: root causes (workstreams B and C)

Branch `feature/assistant-answer-quality`, from `main` 6e9fac4. Workstream A (Markdown rendering of answers) is
handled separately (`frontend/src/components/AnswerParts.tsx`) and is not covered here. Synthetic data only; the
live traces were taken on the personal test stand (Claude CLI) with the owner's approval and contain no secrets.

## Evidence used

| Kind | Where |
|---|---|
| Live «before» traces, 5 questions (`POST /api/assistant/ask`, follow-up with `history[].context` like the UI) | session scratchpad `answer-quality/before/Q*.json` (not committed) |
| Stand identity | `GET /api/assistant/instructions` → `instr-1a94fcf52f` = the version computed locally on 6e9fac4; `ai_mode: claude_cli`, `demo_content: true`. The stand exposes no commit id, so «stand = 6e9fac4» is confirmed for the assistant instructions and by identical server texts, not by a commit hash. |
| Deterministic pre-retrieval traces (`AssistantService._prepare`, full synthetic base) | scratchpad `answer-quality/{before,after}/trace_prepare.json` |
| Tests written before the fix: 17 collected, 16 failed on 6e9fac4 (the topic-switch case of `test_follow_up_retrieval_keeps_both_readings` already passed) | `backend/tests/test_answer_provenance.py`; scratchpad `before/pytest_new_tests_before*.txt` |
| Scripted double / mock before vs after | scratchpad `{before,after}/scripted_and_mock.json` (6e9fac4 tree vs this branch, same script) |

## Confirmed root causes

### R1 — a fixed «only demo» warning is server-generated on almost every answer (confirmed)

`backend/app/services/assistant.py` (6e9fac4): `DEMO_WARNING` inserted by
- `_validated_response`: `used = cited passages if citations else ALL passages` → any retrieved demo passage, cited
  or not; and `not passages and demo is not False` → every answer without passages unless the caller passed
  `demo=False` explicitly — the non-tool path never did, so even a non-demo (GitLab) base got «only demo».
- `_finish_tools` → `_knowledge_is_demo()` = `any(d.is_demo for d in accessible documents)` for tool answers
  without passages (a property of the catalog, not of the answer).
- `_limit_response`: when the loop stopped, also when there were no passages at all.
- `services/skills.py::_from_proposal`: for skill results.

Evidence: all 5 live answers carry it (also Q3, whose text already discloses provenance, and Q5, a catalog fact);
tests `test_answers_without_evidence_make_no_provenance_claim`, `test_no_passages_on_a_non_demo_base_is_not_called_demo`,
`test_tool_answers_and_failures_never_claim_only_demo[*]` failed on 6e9fac4 with exactly this warning. The UI already
shows a per-source «демо» badge (`AnswerSources.tsx`, `AnswerParts.tsx` from `Citation.is_demo`), so the warning
duplicated metadata.

Fix: `AskResponse.provenance` + `Citation.provenance` from the validated evidence (`app/domain/provenance.py`); a
warning only for mixed synthetic / non-synthetic evidence (commit «provenance is metadata…»).

### R2 — the model's disclaimers come from the corpus text, not from metadata (confirmed)

`format_passages` (6e9fac4) gave the model no provenance field at all; every synthetic document opens with
«> Синтетический демо-документ: описывает вымышленную учебную модель, не системы банка.» (74 of 83 fixtures). The
model quoted that line as evidence: live Q1 «Документ сам оговаривает, что это синтетический пример, а не системы
банка [2]», Q2 «…помечен как «Synthetic demo document…» [1]», Q4 «Документ описывает вымышленную учебную модель,
а не системы банка [3]» (a citation spent on the disclaimer). The previous answer (history) then carried the
disclaimer into the next turn.

Fix: passages and catalog rows carry `synthetic` as data; `RETRIEVAL_GROUNDING` v3 says provenance is metadata shown
by the UI, explicit only when material; R3 removes the banner from the evidence. No keyword filtering of model text.

### R3 — corpus-wide boilerplate outranks content in passage selection (confirmed)

`RetrievalService.passages` takes the best FTS chunk per document. The banner section is short and contains
«модель», so for «Какая у нас модель данных?» it was the best chunk of 4 of the 6 passages (trace
`before/trace_prepare.json`: DEMO-GUIDE-005, DEMO-GOV-002, DEMO-GOV-005, DEMO-GUIDE-002 → banner text only). The
same held for `knowledge_search` (the scripted double's default «quote the first passage» quoted the banner:
`before/scripted_and_mock.json`, `scripted_ordinary_first_passage`) and for `read` without sections.
Test: `test_boilerplate_is_not_handed_to_the_model_as_evidence` (failed on 6e9fac4).

Fix: lines repeated in ≥ 5 documents and > 5 % of the reader's snapshot are boilerplate; a section made only of them
is skipped for the next section of the same document. Ranking and index unchanged; knowledge-eval unchanged.

### R4 — broad questions were answered from a small lexical window without looking at the catalog (confirmed)

Pre-retrieval = ≤ 6 passages of ≤ 4 documents (`_prepare` → `passages(max_documents=4)`); for «модель данных» 12
documents tie at score 10.0 and the tie is broken by ID, so the actual model documents (DEMO-SEM-002…006) ranked
8th–12th and were cut. Live Q1: `tool_steps: []` — the model answered from that window, concluded «В переданных
фрагментах нет единой модели данных команды, есть только учебный пример» and «Данных недостаточно, чтобы описать
вашу фактическую модель», and asked to clarify. Nothing in the policy said the passages are a sample or how to
answer an overview (the catalog tool description listed only «сколько / какие документы»). By contrast the live
Q5 («Какие источники данных у нас описаны?») used `catalog_query list type=source` and gave a good overview — the
model can do it when the question maps to an obvious filter.

Fix (model-driven, no classifier): `TOOL_POLICY` v3 + tool descriptions + the data message: the passages are a
sample; an overview = catalog (`list`/`facets` by type/tags/text) + content (`knowledge_search`) with [F]/[C];
«в просмотренных источниках не найдено», never «в базе нет»; scope «в доступных вам документах SKH»; answer first.
Test: `test_broad_question_gets_a_scope_aware_overview` (scripted double; checks the policy reaches the model).

### R5 — follow-up retrieval by concatenation distorts both readings (confirmed)

`_prepare` retrieved «<question> <previous question>» only. Deterministic probe: «а физическая?» after «Что такое
логическая модель BusinessProcess?» lost DEMO-SEM-005 (the physical model, first when asked alone); «а какие у него
ограничения?» lost the passage of its own words; the previous question's words were reported as «не найдено»
(`unmatched_terms`), and an absent entity of an earlier unanswered question («ЦФТ») made the mock refuse a new
subject. Tests: `test_follow_up_retrieval_keeps_both_readings[*]`,
`test_a_word_missing_from_an_earlier_question_never_blocks_a_new_subject`; eval `KQ-FUP-01`, `KQ-FUP-07`.

Fix: a follow-up is retrieved by its own words AND with the previous question, merged round-robin; unmatched terms
are those of the current question; the previous question's terms reach the provider only as `context_terms`.

### R6 — the follow-up «нам интересны демо-файлы» lost its referent in the model (confirmed in the live trace)

Live Q2 (history + `context` sent like the UI): the model ran `catalog_query list text="демо"` + `facets`, reported
80 text matches, an inventory and «Их нельзя принимать за описание реальных систем банка» — the subject of the
dialog (data models) was dropped. The pre-retrieval did keep the referent (DEMO-GUIDE-005, DEMO-SRC-003 CATIA), but
mostly as banner passages (R3), and the policy said nothing about short follow-ups.

Fix: `TOOL_POLICY` v3 (a short reply continues the previous question; search by its subject; no inventory instead of
an answer), `knowledge_search` description, R3. Test: `test_follow_up_continues_the_referent_without_a_disclaimer`.

## Not confirmed / hypotheses

- **Validation discarding good evidence** — not observed: no live answer had dropped citations or facts.
- **Provider prompt bias** — not observed: no provider or protocol prompt mentions demo data; the bias came from
  passage text (R2) and the server warning (R1).
- **Ambiguous domain** («модель данных» = the SKH application schema vs models documented in the corpus) —
  plausible (live Q1 asked «о какой модели идёт речь»), addressed by policy wording; not separately measurable.
- **The fixes change the real model's behaviour** — HYPOTHESIS until a live «after» run: the stand was not
  redeployed (deploy not requested). The scripted double proves the server side (tools, validation, provenance,
  prompts); whether Sonnet now calls the catalog for broad questions must be checked live
  (`SKH_LIVE_EVAL=1 make knowledge-eval-live` now includes the `provenance` and `followup` categories, plus the two
  dialog questions by hand).
- **Document ranking for generic queries** — remains: ties at the same score are broken by ID and banner words
  still count in the FTS document score (only passage selection was fixed). Changing ranking/index needs its own
  before/after eval.

## Measurements

- `knowledge-eval` (same fixtures): original 200 cases before 191 pass / R@1 0.9487 / R@5 0.9744 / MRR 0.9647 /
  leaks 0 / context_ok 33/38 → after identical. New 16 cases (`fixtures/eval/cases_answer_quality.yaml`): 6e9fac4
  tree with the new harness 5/16 → 16/16.
- New pytest module `tests/test_answer_provenance.py`: 18 tests (17 written first, 16 of them failed on 6e9fac4; the
  18th — an earlier unanswered question must not block a new subject — was added after the eval found it).
