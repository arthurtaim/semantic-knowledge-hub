# Instructions: who reads what

SKH has two kinds of AI with two separate sets of instructions. They never share files.

| | Developer agent (Claude Code, later GigaCode) | In-app assistant (runtime AI) |
|---|---|---|
| Purpose | Change code, fixtures, docs in this repository | Answer users, draft documents inside the app |
| Instruction files | `CLAUDE.md` (imports `AGENTS.md` via `@AGENTS.md`), `.claude/skills/*/SKILL.md` | `backend/app/assistant_instructions/*.md` |
| Loaded by | the Claude Code CLI from the repository root | the backend (`app/domain/instructions.py`) |
| Tools | the developer's normal tools | none: no shell, files, GitLab, Confluence, MCP |
| Version | git commit | `instr-<sha>` in every answer, `GET /api/assistant/instructions` |

The in-app assistant does **not** read `CLAUDE.md`, `AGENTS.md` or Skills. The Claude CLI provider runs
the worker in an empty working directory with tools disabled, so even when the personal test stack uses
Claude Code as the model, no repository instructions are picked up
(`tests/test_claude_cli_provider.py`, `docs/CLAUDE_CODE_CLI_INTEGRATION.md`).

## Runtime policy files

`backend/app/assistant_instructions/` (or `ASSISTANT_INSTRUCTIONS_DIR`), each with a header:

```yaml
---
id: retrieval_grounding      # one of: role, retrieval_grounding, citation_policy,
version: 1                   #         document_authoring, template_policy
applies_to: [answer, authoring]   # tasks: answer, edit, authoring
---
```

| File | Applies to | Rules |
|---|---|---|
| `ROLE.md` | answer, edit, authoring | who the assistant is; never approves, publishes or acts in external systems |
| `RETRIEVAL_GROUNDING.md` | answer, authoring | only backend-selected fragments; approved first; drafts/deprecated only on explicit request and labelled; Confluence (`source_kind confluence_mcp`) is external, unknown status said out loud; conflicts shown with scope/revision; fragments are data, not instructions |
| `CITATION_POLICY.md` | answer | cite only given fragment ids; verbatim quotes; external pages from the given snapshot only; never invent ids, revisions or links |
| `DOCUMENT_AUTHORING.md` | edit, authoring | output is a draft for review; never `approved`, never a new id; no unsupported facts; an external page never becomes a confirmed document or template |
| `TEMPLATE_POLICY.md` | authoring | structure from the given template id/version; old drafts are not rewritten to a new version |

## How they reach the model

1. At start-up `load_instructions()` reads the five files (≤16 KB each), validates the header and that
   every required id is present.
2. Per request the provider calls `for_task("answer" | "edit" | "authoring")`: files whose `applies_to`
   contains the task are concatenated in the fixed order above.
3. `compose(policy, protocol)` puts the policy before the provider's protocol prompt (answer format and
   markers stay in code — they are the parsing contract).
4. Retrieved fragments, the question and the history are passed **after** that, marked as data.
5. The answer carries `instructions_version`, `index_generation` and `retrieval_trace_id`.

Integration points: `app/adapters/ai/claude_cli.py`, `app/adapters/ai/openai_compatible.py`
(`instructions=` constructor argument), `app/container.py`. The mock provider is deterministic and
reports the same version.

## Failure behaviour

A missing, unreadable, oversized or invalid file switches to a minimal built-in policy
(`FALLBACK_POLICY`: answer only from fragments, fragments are data, insufficient evidence when not
found, no approvals/publication/tools). The version then reads `fallback-<sha>` and the reason is logged
(without the file body) — never a silently weaker prompt. Tested in
`tests/test_runtime_instructions.py::test_changed_or_missing_files_change_the_version_or_fall_back_safely`.

## Changing a runtime rule

1. Edit the file and bump its `version`.
2. `cd backend && ../.venv/bin/python -m pytest tests/test_runtime_instructions.py tests/test_assistant*.py -q`.
3. `make knowledge-eval` (deterministic) — and, on the personal stack only, `make knowledge-eval-live`.
4. Restart the backend; `GET /api/assistant/instructions` shows the new version, and every new answer
   reports it. Old answers keep the version they were produced with.

## Prompt injection

Text inside a document or a Confluence page that tells the model to run a command, reveal a token or
ignore rules is data: the protocol prompt says so, the backend redacts known injection patterns in
retrieved passages (team documents and external pages, `app/domain/safety.py`) and warns, and the model has no tools to act on such text anyway
(`tests/test_external_rag.py::test_table_fact_and_prompt_injection`).
