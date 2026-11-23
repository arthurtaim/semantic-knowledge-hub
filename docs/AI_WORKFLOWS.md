# AI-first knowledge workflows (M5.6.3)

```text
UI action (+ document / draft / selection / goal)
 -> AiWorkflowService: reader-scoped evidence (search, graph, links) + PINNED template from the registry
 -> AIProvider only for text (assist: improve / summarize; draft_document): mock | Claude CLI (personal test)
    | internal OpenAI-compatible API (GigaCode-ready); no tools, inputs are data
 -> typed proposal (items + evidence), stored with its base (draft version / revision / template version)
 -> person accepts chosen items -> applied to a DRAFT (an approved document gets an update draft)
```

| Kind | Input | Output | Accept applies |
|---|---|---|---|
| `draft_from_prompt` | prompt, title?, template_id? | recommended active template + alternatives with reasons, evidence-backed draft (unknown facts stay «Требует уточнения»), tags, related | new draft (`origin: ai_suggestion`) |
| `suggest_metadata` | draft or document | tags / summary / related_ids with evidence; owner is never proposed | chosen fields only |
| `improve_section` | section | proposed section text (diff) | that section only |
| `summarize` | selection or document | summary | the `summary` field |
| `explain` | selection / question | grounded answer with citations or «недостаточно данных» | — |
| `check_completeness` | draft or document | missing required sections of the PINNED version, empty sections, missing required fields, broken links | skeletons of chosen sections |
| `find_related` | draft or document | WikiLink proposals `[[ID|Title]]` with evidence (mentions, not business dependencies) | links in the related section |
| `explain_relation` | two documents | path with each edge classified: typed business edge / mention / temporary | — (link to the graph) |
| `impact_analysis` | document | plan: typed dependants first, then mentions, template | — (plan only) |

Rules: nothing is applied without Accept; reject changes nothing; a proposal whose base changed (draft saved
elsewhere, document revised, template got a new version, link target gone) is `invalidated` with 409
`ai_proposal_stale`. The AI never approves, merges, publishes or calls GitLab/Confluence. Retrieved text,
user text and template guidance are data. Proposals are audited (`ai_proposals` table) without the prompt
text (a hash only). Invalid model JSON is `ai_invalid_response`, never a proposal.

API: `POST /api/ai/proposals`, `GET /api/ai/proposals[?draft_id=&document_id=]`,
`GET /api/ai/proposals/{id}`, `POST /api/ai/proposals/{id}/accept {item_ids}`, `POST …/reject`.

The deterministic mock serves every workflow offline (`assist` quotes / normalizes, never invents);
live checks with the Claude CLI are opt-in and synthetic. Checks: `tests/test_ai_workflows.py`,
eval cases `KM-AI-*`.
