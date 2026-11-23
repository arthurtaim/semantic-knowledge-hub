---
name: template-evolution
description: Add a new SKH document template or a new version of an existing one through the versioned template registry, keep old drafts valid against their own version, and check AI authoring and the UI. Use when changing backend/app/document_templates/.
---

# Template evolution

**Purpose.** Templates are versioned files (`backend/app/document_templates/<id>.md`, previous versions
in `history/<id>.v<N>.md`) loaded into `TemplateRegistry`
(`backend/app/domain/template_registry.py`). New versions apply to new documents only.

**When to use.** New document kind; a required section added/renamed/removed; a template hidden from
the picker (`listed: false`).

**Inputs.** Template id, the change, why existing drafts may or may not need a manual update.

## Procedure
1. **New id or new version?** A different kind of document → new file with a new `template_id`,
   `version: 1`.
   A change of an existing kind → copy the current file to `history/<id>.v<N>.md` unchanged, then
   edit the main file and set `version: N+1`. Never edit a history file.
2. **Registry reload.** Restart or `POST /api/index/sync`; `GET /api/authoring/templates` shows `version` and
   `previous_versions`. An edit without a version bump is detected by checksum and auto-bumped — treat
   that as a mistake to fix.
3. **Old drafts.** A draft stores `template_version`; it is still validated against that version and
   the UI shows a notice that a newer version exists. Nothing is migrated silently.
4. **AI authoring.** `POST /api/authoring/check` with the new template; the assistant's authoring
   policy (`backend/app/assistant_instructions/TEMPLATE_POLICY.md`) uses the version it is given.
5. **Docs.** Update `docs/DOCUMENT_TEMPLATES.md` (sections, purpose, version history).

## Validation commands
```bash
cd backend && ../.venv/bin/python -m pytest tests/test_template_registry.py tests/test_authoring.py -q
make knowledge-eval        # template scenarios KE-TP-001…008 (new template, old draft compatibility)
make e2e                   # if the picker or the notice changed
```

## Expected outputs
Registry lists the new version; an old draft validates against its stored version; a new draft gets
the new version; eval template scenarios pass.

## Constraints
No real corporate templates or examples. Don't delete a version that existing drafts reference.
`external_import` stays `listed: false` (only created from an external page via explicit propose).

## Example (checkable)
`integration` v2 added four sections; v1 lives in `history/integration.v1.md`
(`tests/test_template_registry.py::test_old_draft_is_validated_against_its_template_version`).
