# START HERE — initial Claude Code execution prompt

This file is the first instruction to paste into Claude Code after checking out the new GitHub repository. The detailed requirements are in `docs/`.

## Paste this prompt to Claude Code

> You are the principal engineer implementing the AI-native Semantic Knowledge Hub from scratch. Read `CLAUDE.md`, `AGENTS.md`, and ALL documents in `docs/` first. Then build a **working local vertical slice**, not a design-only proposal.
>
> Implement milestones M0–M3 from `docs/IMPLEMENTATION_PLAN.md` in order, with tests, and proceed with mock-based M4 adapters if feasible. Build the app with a Russian UI, a local synthetic knowledge corpus, document browsing, full-text search, metadata/status tags, a grounded AI demo with explicit citations, and a reviewable proposed edit/diff workflow. Include Docker Compose and documented non-Docker startup. Runtime must work entirely offline without credentials.
>
> **Crucial separation:** This GitHub repository contains code; real team knowledge is in a separate GitLab repository. Confluence Data Center is an external corporate knowledge source accessed through read-only MCP, and later an optional publication target. Use clear provider interfaces and config flags, with GitLab/Confluence mock connectors until approved credentials are available. Do not create real bank documentation, copy files from external sources, or connect to third-party AI APIs by default.
>
> Begin by inspecting this repository, writing a concise execution checklist, and immediately implementing the first end-to-end slice. Run actual tests and application smoke checks. Fix failures. Continue to the next milestone without requiring a new prompt unless blocked by a genuine dependency. Finish with exact startup commands, implementation status, tests run, and a prioritized list of any outstanding work.

## Before first run
- Create a **private** GitHub repository for application code.
- Upload this starter pack to the repository root (keep the directory structure).
- Start Claude Code from the repository root; use an approved AI account/configuration.
- Never put proprietary bank documents in this code repository or into external prompts during development.

## How to run after Claude has implemented the application
Follow the generated `README.md` and `.env.example` for `docker compose up --build`, visit the local URL shown there and verify acceptance scenarios in `docs/TEST_PLAN.md`.

## The first three product workflows
1. **Find**: search and open a local synthetic document; display title, owner, status, commit/version and source.
2. **Ask**: ask a question, receive a grounded answer with citations or an explicit insufficient-evidence message.
3. **Propose**: request an edit, inspect a before/after diff, approve/reject a proposal locally; never update an approved source without review.

Note: `CLAUDE.md` is a project instruction file that Claude Code reads; this `START_HERE.md` is the task brief. Keep both.
