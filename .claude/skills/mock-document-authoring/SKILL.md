---
name: mock-document-authoring
description: Add a new SYNTHETIC document to the SKH mock knowledge base (fixtures/knowledge) — choose type, write YAML frontmatter and body, declare typed relations, validate, and prove it is found in the index. Use when asked to create a demo/mock/fixture document or to extend the synthetic corpus.
---

# Mock document authoring

**Purpose.** Grow `fixtures/knowledge/` with a realistic but fully synthetic document that validates,
links into the typed graph and is findable by search and the assistant.

**When to use.** "Add a mock document about X", "extend the synthetic base", a new eval case needs a
document that does not exist yet. Not for real team documents (they live in GitLab) and not for
templates (`template-evolution`).

**Inputs.** Topic; doc type (`source`, `dataset`, `integration`, `domain`, `glossary`, `governance`,
`process`, `adr`, `guide`, …); owner; the existing documents it relates to.

## Procedure
1. **Pick id and folder.** Next free id in the family (`ls fixtures/knowledge/<folder>`), e.g.
   `DEMO-INT-016` in `integrations/`. Ids are stable forever; never reuse a deleted id.
2. **Frontmatter** (see `docs/DOCUMENT_SCHEMA.md`, `docs/MOCK_KNOWLEDGE_BASE.md`): `id`, `title`, `type`,
   `status` (new mock docs are `approved` only if the scenario needs it; otherwise `draft`), `owner`,
   `version: "1.0"`, `synthetic: true`, `reviewed_at`, `tags` (RU + EN forms), `aliases` (alternative
   titles users would type), `summary` (one sentence with the key facts), `related_ids`, and typed
   `relations:` (`depends_on`, `consumes`, `produces`, `maps_to`, `derived_from`, `describes`,
   `constrains`, `supersedes`, `uses_template`).
3. **Body.** First line after the title: `> Синтетический демо-документ: …`. Use `##` sections; put
   concrete, checkable facts (names, codes, numbers, owners) under headings — retrieval cites sections.
   If the doc was created from a template, follow that template's sections and set `template` /
   `template_version`.
4. **Links.** Every id in `related_ids`/`relations` must exist; add the reverse relation to the target
   only when it is a real dependency (relations are declared, never inferred).
5. **Validate and index** (commands below). Fix every error; warnings need a reason.
6. **Gold case.** Add at least one case to the matching `fixtures/eval/cases_*.yaml` (question that only
   this document answers, `expected_doc_ids`, `facts_required`).

7. **Links in the body.** Mention related documents as `[[ID]]` or `[[ID|label]]` (in tables `[[ID\|label]]`),
   never by title alone; links are `references`, typed dependencies stay in `relations:`.

## Validation commands
```bash
make mock-kb-validate                    # schema, links, required chains, synthetic flag, secrets
make knowledge-eval                      # the new case must pass; no regression elsewhere
cd backend && ../.venv/bin/python -m pytest tests/test_knowledge_base.py -q
```

## Expected outputs
`reports/knowledge-eval/validation.json` with `"errors": []` and the doc counted; the new eval case
`PASS`; Recall@5/MRR not lower than before.

## Constraints
Synthetic content only (no bank systems, people, URLs, tokens); `synthetic: true` is mandatory
(`--strict-synthetic` fails otherwise). Never mark a document `approved` to make a test pass. Do not
edit `fixtures/knowledge_updates/` for this — those are lifecycle snapshots.

## Example (checkable)
`fixtures/knowledge/semantics/DEMO-SEM-002.md` — `type: domain`, `relations: derived_from:
[DEMO-SRC-002]`, aliases `BusinessProcess`; the gold set finds it for «логическая модель процесса»
(`tests/test_knowledge_base.py::test_acceptance_targets_on_the_gold_set`).
