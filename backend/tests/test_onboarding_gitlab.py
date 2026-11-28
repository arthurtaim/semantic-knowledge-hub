"""OB-17: a file confirmed from an onboarding batch is an ordinary draft — searchable, cited and in the graph only
after the existing review → GitLab merge request → merge → sync. Against the stateful GitLab TEST DOUBLE (no network;
nothing here proves real-GitLab behaviour)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.support.gitlab_env import BASE_URL, Env
from tests.test_onboarding import zip_bytes

MARKER = "МаркерМассовогоИмпортаОнбординг"
FILE = f"""---
id: DEMO-ONB-001
title: Синтетический документ из пакета
type: guide
status: draft
owner: demo-team
tags: [demo]
---
# Синтетический документ из пакета

{MARKER}: учебный текст. См. [[SEM-ARCH-001]].
"""


def test_ob17_a_confirmed_file_becomes_knowledge_only_after_merge_and_sync(gitlab: Env) -> None:
    client = gitlab.client
    assert client.get("/api/search", params={"q": MARKER}).json()["items"] == []
    generation = client.get("/api/index/status").json()["generation"]
    uploaded = client.post(
        "/api/onboarding/batches",
        files=[("files", ("batch.zip", zip_bytes({"onb.md": FILE}), "application/zip"))],
    ).json()
    item_id = uploaded["items"][0]["item_id"]
    plan = client.post(
        f"/api/onboarding/batches/{uploaded['batch_id']}/preview", json={"item_ids": [item_id]}
    ).json()
    result = client.post(
        f"/api/onboarding/batches/{uploaded['batch_id']}/confirm",
        json={
            "expected_revision": plan["revision"],
            "fingerprint": plan["fingerprint"],
            "item_ids": [item_id],
            "idempotency_key": "onb-gitlab-0001",
        },
    ).json()
    proposal_id = result["outcomes"][item_id]["proposal_id"]
    # a draft: no document, no search hit, no new index generation, no GitLab write yet
    assert client.get("/api/documents/DEMO-ONB-001").status_code == 404
    assert client.get("/api/search", params={"q": MARKER}).json()["items"] == []
    assert client.get("/api/search", params={"q": MARKER, "include_drafts": "true"}).json()["items"] == []
    assert client.get("/api/graph/nodes/doc:DEMO-ONB-001/neighbors").status_code == 404  # no graph node yet
    assert client.get("/api/index/status").json()["generation"] == generation
    assert gitlab.state.mrs == [] and list(gitlab.state.branches) == ["main"]
    # the ordinary review flow
    assert client.post(f"/api/drafts/{proposal_id}/mark-ready").status_code == 200
    submitted = client.post(f"/api/drafts/{proposal_id}/submit")
    assert submitted.status_code == 200, submitted.text
    assert (
        client.get("/api/search", params={"q": MARKER, "include_drafts": "true"}).json()["items"] == []
    )  # an open MR is not knowledge
    merged = TestClient(gitlab.mock, base_url=BASE_URL).post("/__mock__/merge-requests/1/merge")
    assert merged.status_code == 200, merged.text
    status = client.post(f"/api/drafts/{proposal_id}/refresh-status").json()
    assert status["status"] == "merged"
    doc = client.get("/api/documents/DEMO-ONB-001").json()
    assert doc["status"] == "draft"  # the file's own status: onboarding never promotes it to approved
    hits = client.get("/api/search", params={"q": MARKER, "include_drafts": "true"}).json()["items"]
    assert [h["id"] for h in hits] == ["DEMO-ONB-001"]
    assert client.get("/api/index/status").json()["generation"] > generation
    neighbors = client.get("/api/graph/nodes/doc:DEMO-ONB-001/neighbors").json()
    assert any(
        "SEM-ARCH-001" in (e.get("target", "") + e.get("source", "")) for e in neighbors.get("edges", [])
    )
