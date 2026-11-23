# Instruction loading check (M5.6.2 Appendix 4 §6)

Date: 2026-11-23. Claude Code CLI 2.1.318, run from the repository root, `claude -p`.

## Developer agent (Claude Code)

Probe 1 — `--tools "" --max-turns 2 --output-format stream-json --verbose`, question about the loaded
instructions (no tool use, 1 turn):

| Check | Evidence | Result |
|---|---|---|
| `CLAUDE.md` read from repo root | `init.cwd` = repository root; the model answered from CLAUDE.md content | pass |
| `AGENTS.md` loaded via `@AGENTS.md` | the model quoted verbatim `## Engineering invariants (M5.6.2)` and the first bullet «**Read before changing.** Inspect the current code and contracts; extend interfaces backwards-compatibly;» — text that exists only in AGENTS.md | pass |
| Import mechanism named correctly | «`CLAUDE.md` подключает его строкой `@AGENTS.md`» | pass |
| Project Skills discovered | `init.skills` contains all 10: dataset-specification, document-update-and-sync, external-knowledge-acquisition, integration-specification, knowledge-graph-exploration, knowledge-navigation, knowledge-quality-review, mock-document-authoring, search-retrieval-evaluation, template-evolution | pass (10/10) |
| Runtime separation understood | «Нет… правила не доходят до встроенного ассистента… `backend/app/assistant_instructions/`» | pass |

Note: with `--tools ""` the Skill tool itself is disabled, so the model does not see skill descriptions
(it said so instead of guessing) — skills are listed by the CLI in `init.skills` regardless.

Probe 2 — `--tools "Skill" --max-turns 1`, five tasks, "name the best project skill, do not invoke":

| Task | Chosen skill | Expected |
|---|---|---|
| rename a document, old title must disappear from search | document-update-and-sync | ✓ |
| add a required section to the integration template | template-evolution | ✓ |
| why a Confluence page was cited, purge its cache | external-knowledge-acquisition | ✓ |
| is the ARIS → dataset lineage chain a graph path | knowledge-graph-exploration | ✓ |
| synonym dictionary changed, measure before/after | search-retrieval-evaluation | ✓ |

5/5. Every skill's "checkable example" refers to an existing test or gold case; the referenced tests were
run (`pytest tests/test_knowledge_base.py tests/test_sync_and_graph.py tests/test_kb_sync_tool.py
tests/test_template_registry.py tests/test_authoring.py::test_templates_with_required_structure_and_free_ids
tests/test_external_rag.py tests/test_runtime_instructions.py` → 34 passed).

## In-app assistant (runtime)

| Check | Where | Result |
|---|---|---|
| Developer files never reach the runtime model | Claude CLI worker: empty private cwd per request, `--tools ""`, `--restricted` (project/user settings ignored), no MCP (`backend/claude_worker/runner.py`); OpenAI-compatible and mock providers get only the composed runtime policy | by construction + `tests/test_claude_cli_provider.py` |
| `instructions_version` in every answer, `GET /api/assistant/instructions` | `tests/test_runtime_instructions.py::test_version_is_reported_by_the_api_and_every_answer` | pass |
| Changed file → new version; missing/invalid → `fallback-<sha>` safe policy | `::test_changed_or_missing_files_change_the_version_or_fall_back_safely` | pass |
| Prompt injection in retrieved text does not override policy | `tests/test_external_rag.py::test_table_fact_and_prompt_injection` | pass |
| `index_generation`, template registry label visible | every answer; `GET /api/index/status` | pass |
