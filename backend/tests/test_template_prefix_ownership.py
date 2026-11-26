"""Post-M6 remediation A4 (audit SYS-002): one rule of `id_prefix` ownership in Template Studio.

- An ACTIVE template (shipped, adopted or born in the studio) owns its prefix. Its own draft never conflicts with it,
  whatever other drafts exist.
- A draft of a never-activated template only reserves a prefix that no active template owns; among such drafts the
  earliest one wins (two drafts never block each other).
- A foreign draft that names an owned prefix is told so when it is created or checked (`id_prefix_taken`) and can
  never be activated — but it can no longer block the owner.
Versions pinned by existing documents are untouched: the rule only decides which spec may be activated."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi.testclient import TestClient

from tests.test_template_studio import TID, activate, create, ok, save, spec, state

FOREIGN = "junk_exchange"


def errors(check: dict[str, Any]) -> dict[str, str]:
    return {i["field"]: i["code"] for i in check["issues"] if i["severity"] == "error"}


def activate_raw(client: TestClient, tid: str) -> Any:
    return client.post(
        f"/api/templates/{tid}/studio/activate", json={"expected_revision": state(client, tid)["revision"]}
    )


def test_a_foreign_draft_with_the_owners_prefix_no_longer_blocks_the_owner(client: TestClient) -> None:
    """SYS-002: owner active (SEM-EXCH) → foreign draft with SEM-EXCH → the owner's next activation used to get 422."""
    create(client)
    activate(client)
    foreign = create(client, template_id=FOREIGN, title="Мусорный черновик", sections=[])
    assert (
        errors(foreign["check"])["id_prefix"] == "id_prefix_taken"
    )  # detected when the foreign draft is created

    save(client, spec(description="Уточнённое описание обмена."))  # info_update of the owner
    assert activate(client)["action"] == "info_updated"
    sections = [*spec()["sections"], {"title": "Мониторинг", "required": True, "hint": "", "content": ""}]
    save(client, spec(sections=sections))  # a schema change → a new version of the owner
    assert activate(client)["version"] == 2

    refused = activate_raw(client, FOREIGN)
    assert refused.status_code == 422, refused.text
    assert {i["code"] for i in refused.json()["details"]["issues"]} >= {"id_prefix_taken"}
    assert [v["version"] for v in state(client)["versions"]] == [1, 2]  # v1 stays for documents pinned to it


def test_a_foreign_draft_cannot_block_an_adopted_shipped_template(client: TestClient) -> None:
    """Shipped «integration» owns SEM-INT; a foreign draft names it; editing the shipped template in the studio still activates."""
    foreign = create(client, template_id=FOREIGN, id_prefix="SEM-INT")
    assert errors(foreign["check"])["id_prefix"] == "id_prefix_taken"
    current = state(client, "integration")
    edited = current["current"] | {"description": "Уточнено в студии (синтетика)."}
    saved = ok(
        client.put(
            "/api/templates/integration/studio/draft",
            json={"spec": edited, "expected_revision": current["revision"]},
        )
    )
    assert saved["state"]["kind"] == "adopted" and saved["check"]["valid"] is True

    assert activate(client, "integration")["action"] == "info_updated"


def test_two_drafts_with_one_free_prefix_the_earlier_one_wins(client: TestClient) -> None:
    """No active owner: the first draft reserves the prefix and activates; the later one is told who has it."""
    first = create(client)
    second = create(client, template_id=FOREIGN, title="Второй обмен")
    assert "id_prefix" not in errors(first["check"])
    assert errors(second["check"])["id_prefix"] == "id_prefix_taken"
    recheck_first = ok(
        client.post("/api/templates/studio/validate", json={"spec": spec(), "template_id": TID})
    )
    assert "id_prefix" not in errors(recheck_first)  # the later draft does not block the earlier one

    assert activate(client)["version"] == 1
    refused = activate_raw(client, FOREIGN)
    assert refused.status_code == 422, refused.text
    assert TID in refused.json()["details"]["issues"][0]["message"]


def test_the_rule_survives_a_restart(client_factory: Callable[..., TestClient]) -> None:
    first = client_factory()
    create(first)
    activate(first)
    create(first, template_id=FOREIGN, title="Мусорный черновик")
    first.app.state.container.close()  # type: ignore[attr-defined]

    second = client_factory()  # a new backend on the same data directory
    save(second, spec(description="После перезапуска."))
    assert activate(second)["action"] == "info_updated"
    assert activate_raw(second, FOREIGN).status_code == 422
