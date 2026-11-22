# Knowledge document schema and governance

## 1. Canonical content
Team knowledge consists of UTF-8 Markdown files with YAML frontmatter stored in a **separate GitLab repository**. The application code repository in GitHub has only synthetic fixture examples. The local workspace used during development is `.gitignore`d.

Example:

```md
---
id: SEM-INT-ARIS-001
title: ARIS metadata integration overview
type: integration
status: draft
owner: semantic-layer-team
reviewed_at: null
tags: [metadata, aris, integration]
related_ids: [SEM-ARCH-001]
source_refs: []
---

# ARIS metadata integration overview

> DEMO ONLY — synthetic placeholder. Replace with bank-approved sources in GitLab.

## Purpose
This page is a documentation-template example, not a bank architecture fact.

## Open questions
- Which attributes are transferred?
- Which restrictions apply?
```

Required fields: `id`, `title`, `type`, `status`, `owner`, `tags`. Optional: `reviewed_at`, `related_ids`, `source_refs`, `confluence_page_id` (prefer separate sync-state mapping to avoid putting platform-specific IDs in content), `summary`.

## 2. Controlled vocabulary
- `type`: `overview`, `architecture`, `domain`, `integration`, `process`, `decision`, `standard`, `glossary`.
- `status`: `draft`, `in_review`, `approved`, `deprecated`.
- `owner`: stable team/user identifier; avoid unmaintained free-text where possible.
- `id`: unique immutable logical identifier, case insensitive uniqueness check.

## 3. Lifecycle
`draft -> in_review -> approved -> deprecated` with revisions via GitLab MR. AI may suggest any state but may not move to `approved` or directly publish without authorized human action and protected-branch approval. Reconsidering `deprecated` creates an MR, not a silent status mutation.

## 4. Checks
- YAML parses; known fields validated and unknown fields handled explicitly.
- Stable unique IDs, correct links/relations, headings, nonempty meaningful body.
- Approved documents require owner, meaningful source provenance when they claim external requirements, and recent human review as policy determines.
- Cross-references must resolve or be labeled external. Do not pretend all Confluence source pages are downloadable.
- Disallow secrets and likely personal/customer identifiers in public fixture data.

## 5. Citations/provenance
Each returned source carries `source_type` (`local`, `gitlab`, `confluence`), `document_id`, `title`, `source_uri`, `revision`, `status`, optional `section`, `excerpt` and `retrieved_at`. Only cite content actually returned from authorized adapters.

## 6. Storage mapping
GitLab: authoritative `.md` files and supporting `.png/.svg` diagrams where approved. GitHub: application code, schema validators, documentation **about the application**, and synthetic fixtures only. Never write corporate content into GitHub issues or CI logs.
