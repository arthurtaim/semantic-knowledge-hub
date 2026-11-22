# GigaCode migration contract (later)

The bank's target agent environment is **GigaCode**. We are using Claude Code to build and prototype the application first. Do not build the product around undocumented Claude Code runtime APIs or assume GigaCode is identical to GigaChat API.

## What must stay portable
- Canonical documentation: Markdown/YAML in GitLab, stable logical IDs.
- Human workflows: GitLab Merge Requests, approved publication service to Confluence.
- Retrieval, provenance, access control and source filters: independent of LLM provider.
- Corporate knowledge connector: an approved Confluence Data Center MCP server, not model-specific calls.
- Agent rules: shared `AGENTS.md`, separate runtime-specific `GIGACODE.md` later if needed.
- Internal interfaces: `AIProvider`, `CorporateKnowledgeConnector`, `KnowledgeRepository`, `ProposalPublisher`.

## Future migration checklist
1. Identify actual bank-provided GigaCode mode: CLI, IDE plugin, GitVerse workflow or internal server API.
2. Verify on-prem model/provider topology, MFA, credentials, supported MCP transports and tool restrictions.
3. Map application functionality to GigaCode capabilities without inventing endpoints. If no programmatic agent API, keep web app runtime provider independently configured, while using GigaCode as the authoring agent.
4. Implement and test a dedicated adapter; keep provider-independent acceptance tests.
5. Check per-user ACL, citing, tool-call audit, prompt-injection safeguards, replay/timeout handling.
6. Confirm the same GitLab documents and Confluence page mappings remain intact; no migration of canonical content required.
7. Roll out with feature flag, side-by-side evaluation and rollback to the prior approved provider.

## Anti-patterns
- Never use the model itself as the only authorization layer.
- Never store prompt/chat transcripts in GitHub if they contain corporate information.
- Never assume Claude Code running on a server means fully local inference.
- Never assume GigaChat `chat/completions` provides GigaCode's full agent tools.

## Where a GigaCode adapter plugs in (as implemented)
- Runtime answers: implement the `AIProvider` protocol (`backend/app/adapters/ai/base.py`: `answer`, `suggest_edit`, `status`) in a new module and register it in `build_ai()` (`backend/app/container.py`) under a new `AI_PROVIDER` value. The provider receives only already-authorized, delimited passages; `AssistantService` keeps retrieval, ACL and citation validation, so these stay provider-independent.
- Agent tooling: if GigaCode works as an authoring agent (CLI/IDE), it uses the same HTTP API as the UI (`/api/search`, `/api/assistant/ask`, `/api/drafts…`) and the same review gates; it gets no direct write path to GitLab or Confluence.
- Acceptance: run `backend/tests/test_curated_qa.py` and `test_assistant.py` against the new provider (with a mocked transport) before enabling it behind a feature flag.
