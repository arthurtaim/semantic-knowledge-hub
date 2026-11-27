# Failures (after, 216 cases): classification

Run: `make knowledge-eval` on 2026-11-26, branch `fix/skh-retrieval-quality` (retrieval v2 on top of `f4ea26e`;
KB hash `4cc6e409e5231bb3`, cases hash `395a00146d3c1d34`, mock AI, no network). Raw output: `after.json`,
`after_failures.md`. **216 cases, 210 pass, 6 fail, 0 error, 0 unsupported**; the command exits non-zero (module exit 1,
`make` exit 2) while any of these remain. Before retrieval v2 the same suite gave 207 / 9 (baseline re-run on `f4ea26e`:
`reports/README.md`); the full before/after, every case flip and the root-cause analysis are in
`reports/README.md`.

Evidence per case comes from the run itself and from the context the assistant hands to the provider (`context_ok` in
`after.json`: were the expected documents and facts in those passages?).

## Still failing

| Case | Category | Holdout | Expected | Actual (after) | Classification |
|---|---|---|---|---|---|
| `KE-ADR-005` | synthesis | no | cite DEMO-GUIDE-004, DEMO-ADR-002; facts `revision_conflict`, `base_revision`, «Черновик (draft) никогда не авторитетен» | both documents and the sentence are in the context (`context_ok` true); the mock quotes another sentence of the same section | **mock-provider limitation** (extractive mock: ≤ 4 sentences ranked by word overlap). Passed live. Not tuned: `adapters/ai/mock.py` is never fitted to a gold string |
| `KE-SRC-013` | synthesis | no | cite DEMO-SRC-011; facts `DQ-COMP-001`, `95 %`, `24 ч`, `Average Daily Rows` | all facts in the context (`context_ok` true); the mock's quotes go to the ADR definitions (entity-like «ADR» weighs ×2) | **mock-provider limitation**. Passed live |
| `KE-INTA-012` | synthesis | no | cite DEMO-INT-001, DEMO-INT-002; facts `каждые 6 часов`, `500 записей`, `MAP_ARIS_PROCESS` | all 3 facts in the context and cited (the id lookup from the approved DEMO-SRC-002 export table); DEMO-INT-002 is document 8 for this question, not among the 4 context documents (`context_ok` false) | **retrieval defect (document selection)**, unresolved: a document re-ranking by best-section evidence (MaxP) brought DEMO-INT-002 in but admitted weak documents into a no-answer case (KX-DISC-08 lost «insufficient evidence»), so it was rejected (`reports/README.md`) |
| `KE-SRC-012` | synthesis | no | cite DEMO-SRC-004, DEMO-SRC-006; facts `до 15 минут`, `crm_card_id`, `mdm_golden_id`, `mdm_match_score` | both documents in the context; `до 15 минут` and `mdm_golden_id` in it, `crm_card_id` and `mdm_match_score` not (`context_ok` false) | **retrieval defect (passage packing)**, partial: six passages for four documents; DEMO-SRC-006 is document 3 and gets one section. Choosing its first section by word coverage would add `mdm_match_score` but lost facts of other cases (`02_DESIGN_AND_CHANGES.md`) |
| `KE-SRC-004` | synonym | **yes** | DEMO-SRC-008 within top 3 for a colloquial question | rank 8 (unchanged) | **retrieval defect (lexical paraphrase)**: «оповещения / поменялся / шина» vs «уведомления / изменения / Event Hub». Only synonym groups would close it; adding them from a holdout question is forbidden (CLAUDE.md §6) — needs independent dictionary material and a NEW holdout |
| `KX-RAG-04` | external_rag | **yes** | sources team + corporate: cite mock Confluence page 200104, fact `internal` | MCP not called (post-freeze diagnosis: the question's subject word occurs in NO team document, df = 0) | **sufficiency defect**, unresolved: LOCAL_SUFFICIENCY v2 requires the answering document to contain every *specific* word (0 < df ≤ 10 %); a word absent from the whole corpus only counts towards `low_term_coverage` (1/3). Treating df = 0 as decisive would also send paraphrases («пауза» for «задержка», probe RQ-EXT-N1) to the external source; deciding that trade-off on a holdout case is forbidden |

## Fixed by retrieval v2 (2026-11-26)

| Case | Holdout | Root cause | Fix |
|---|---|---|---|
| `KE-SEM-011` | no | the 12-term cap cut the second half of the compound question («номер устаревшего … новому»), and v1 packing gave the best document only its two BM25-best sections | 16 content words, function words never terms; passage packing v2 adds the section that answers the other part |
| `KE-SEM-012` | **yes** | facts in DEMO-SEM-006 sections v1 never packed | the same general change — the holdout case was never traced or looked at before the single post-freeze run |
| `KE-ST-006` | no | (mock limitation) the in_review document was in the context but not quoted | side effect of the changed term set and packing; no rule for it |

Summary: 2 mock-provider limitations, 4 retrieval defects (2 of them holdout). 0 stale or wrong gold oracles, 0 fixture
errors; no case was edited, removed or weakened. `make knowledge-eval` stays honestly red.
