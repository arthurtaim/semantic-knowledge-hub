# Product Requirements — Semantic Knowledge Hub

## 1. Problem and target users
A small bank team building a semantic layer needs an orderly, AI-native knowledge base. Current Confluence team space is mostly empty; the wider bank's Confluence Data Center contains relevant documentation. Team feedback identified poor navigation, incomplete product overview, unclear status/ownership, hard-to-track edits and a desire for intelligent search, documentation updates and a roadmap. The requested working tool should support engineers, data/system analysts and team leads.

## 2. Scope and system boundary
- GitHub stores **application code only** and synthetic tests.
- GitLab stores **real team knowledge** and history in a separate repository. Knowledge is a collection of Markdown/YAML documents; this project is not itself a data warehouse or repository for customer records.
- Confluence Data Center is an external **corporate knowledge source** accessed through read-only MCP, and potentially a publication target for approved GitLab documents.
- Existing task management system is external and unspecified. Display a clear `not connected` status until integration is agreed; never fabricate roadmap items or dates.
- Local demo uses only synthetic fixture documents copied to an ignored workspace. No real integration credentials are required.

## 3. MVP user stories (must build)
P1. As a team member, I can browse a structured document navigation tree, open a document and see title, summary, owner, approval status, labels and source.
P2. I can search documents by keyword in title, body, tags and related entities; the search is reproducible and results contain snippets.
P3. I can ask a natural-language question. With `AI_PROVIDER=mock`, the product returns **clearly marked extractive/demo evidence** with citations rather than hallucinated prose. With a configured approved internal model, a grounded assistant can synthesize an answer from retrieved documents.
P4. A response shows clickable citations linking to accessible source documents with stable IDs and, if possible, section anchors.
P5. I can propose a documentation change and preview a before/after diff. I can reject or mark it ready for review; no silent overwrite of approved documents.
P6. I can filter documents by status, owner, source and tags; missing ownership or stale review date is visually clear.
P7. I can see which external integrations are configured and which are mock/disabled; failures are understandable.
P8. The app runs locally on one machine without external access or credential setup.

## 4. Later user stories (not MVP blockers)
- Read Confluence DC pages through an internal MCP service with per-user ACLs.
- GitLab live read, branch creation and Merge Request for proposals.
- Confluence publication from approved GitLab content, with conflict detection.
- Controlled Confluence-to-GitLab import as an MR, never silent two-way overwrite.
- Change-health scanning, impact analysis and task-system roadmap integration.
- Multiuser SSO/RBAC, audit retention and server hosting.
- GigaCode agent integration with capability mapping to approved interfaces.

## 5. Not in MVP
- Vector database / embeddings / GraphRAG / Neo4j.
- Fabricated semantic-model data, raw customer data, SQL credential storage or execution against bank databases.
- Full graphical document editor, generic drag-and-drop no-code workflows, autonomous write agents.
- Real-time bidirectional synchronization or own Jira replacement.
- Public hosting or unauthorized external AI APIs.

## 6. Success metrics
- A new developer can start the local demo via documented instructions without credentials.
- 10 curated synthetic QA questions have source-grounded answers or explicitly report missing evidence.
- At least one end-to-end create-proposal -> inspect diff -> reject/approve-for-review scenario works in demo.
- Searching for a synthetic entity returns its relevant documents and valid clickable citations.
- Integration status does not imply success when disabled.
- No fixture, token, internal URL or confidential document accidentally reaches GitHub.

## 7. UI copy and language
Russian primary user interface; technical field names and file paths in English. Accessibility, empty states and error feedback matter. Do not add marketing claims.
