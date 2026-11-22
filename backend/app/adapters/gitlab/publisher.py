"""GitLabMRPublisher: turns a reviewed proposal into a branch + commit + Merge Request.

Never commits to the default branch. Idempotent per proposal (stable branch name, existing MR
is reused). Uses GitLab's `last_commit_id` precondition so a changed file is never overwritten.
"""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import quote

from app.adapters.gitlab.client import GitLabClient, GitLabError
from app.adapters.gitlab.repository import GitLabKnowledgeRepository
from app.adapters.publishers.base import ProposalForPublication, PublisherDisabledError, PublishResult
from app.domain.models import IntegrationStatus, UserContext

logger = logging.getLogger("skh.gitlab.publisher")

BRANCH_PREFIX = "skh/proposal-"


def branch_name(proposal_id: str) -> str:
    return f"{BRANCH_PREFIX}{proposal_id[:16]}"


class GitLabMRPublisher:
    enabled = True

    def __init__(self, repository: GitLabKnowledgeRepository) -> None:
        self._repository = repository
        self._client: GitLabClient = repository.client

    async def _branch_exists(self, branch: str) -> bool:
        response = await self._client.request(
            "GET",
            self._client.project_path(f"/repository/branches/{quote(branch, safe='')}"),
            allowed_statuses=frozenset({404}),
        )
        return response.status_code == 200

    async def _ensure_branch(self, branch: str) -> None:
        """Create the proposal branch. The "already exists" answer is not documented, so a 400 is
        resolved by checking the branch explicitly instead of parsing the error text."""
        response = await self._client.request(
            "POST",
            self._client.project_path("/repository/branches"),
            params={"branch": branch, "ref": self._repository.branch},
            allowed_statuses=frozenset({400, 409}),
        )
        if response.status_code >= 300 and not await self._branch_exists(branch):
            raise GitLabError(
                "gitlab_bad_request", "GitLab не создал ветку для предложения.", response.status_code
            )

    async def _branch_has_proposal_commit(self, branch: str, proposal_id: str) -> bool:
        response = await self._client.request(
            "GET",
            self._client.project_path("/repository/commits"),
            params={"ref_name": branch, "per_page": 20},
        )
        commits = response.json() if isinstance(response.json(), list) else []
        return any(f"Proposal-Id: {proposal_id}" in str(c.get("message", "")) for c in commits)

    async def _commit(self, proposal: ProposalForPublication, branch: str) -> None:
        payload: dict[str, Any] = {
            "branch": branch,
            "commit_message": (
                f"docs({proposal.document_id}): {proposal.reason[:120]}\n\n"
                f"Proposal-Id: {proposal.proposal_id}\nBase-Revision: {proposal.base_revision}"
            ),
            "actions": [
                {
                    "action": "update",
                    "file_path": proposal.document_path,
                    "content": proposal.proposed_content,
                    "last_commit_id": proposal.base_revision,
                }
            ],
        }
        await self._client.request("POST", self._client.project_path("/repository/commits"), json=payload)

    async def _find_mr(self, branch: str) -> dict[str, Any] | None:
        """Any MR (opened, merged or closed) for the proposal branch: a closed MR is a reviewer
        decision and must not be silently re-created."""
        response = await self._client.request(
            "GET",
            self._client.project_path("/merge_requests"),
            params={"source_branch": branch, "state": "all"},
        )
        items = response.json()
        return items[0] if isinstance(items, list) and items else None

    async def publish_proposal(self, proposal: ProposalForPublication, user: UserContext) -> PublishResult:
        branch = branch_name(proposal.proposal_id)
        if branch == self._repository.branch:
            raise PublisherDisabledError("gitlab_unsafe_branch", "Запрещено коммитить в основную ветку.")
        try:
            current = await self._repository.current_file_revision(proposal.document_path)
            if current != proposal.base_revision:
                return PublishResult(
                    state="conflict",
                    external_id=None,
                    external_url=None,
                    message="Документ в GitLab изменился после создания предложения; MR не создан.",
                )
            existing = await self._find_mr(branch)
            if existing:
                return PublishResult(
                    state="unchanged",
                    external_id=str(existing.get("iid")),
                    external_url=existing.get("web_url"),
                    message=f"Merge Request для этого предложения уже существует (состояние: {existing.get('state', '—')}).",
                )
            await self._ensure_branch(branch)
            if not await self._branch_has_proposal_commit(branch, proposal.proposal_id):
                try:
                    await self._commit(proposal, branch)
                except GitLabError as exc:
                    if exc.status != 400:
                        raise
                    # GitLab answers a stale `last_commit_id` with a generic 400: decide by state.
                    if (
                        await self._repository.current_file_revision(proposal.document_path)
                        != proposal.base_revision
                    ):
                        return PublishResult(
                            state="conflict",
                            external_id=None,
                            external_url=None,
                            message="GitLab отклонил коммит: файл изменился после создания предложения. MR не создан.",
                        )
                    raise GitLabError(
                        "gitlab_commit_rejected", "GitLab отклонил коммит предложения (400).", 400
                    ) from exc
            response = await self._client.request(
                "POST",
                self._client.project_path("/merge_requests"),
                json={
                    "source_branch": branch,
                    "target_branch": self._repository.branch,
                    "title": f"Draft: {proposal.document_id} — {proposal.reason[:80]}",
                    "description": (
                        "Предложение из Semantic Knowledge Hub. Требует ревью по правилам защищённой ветки.\n\n"
                        f"- Документ: `{proposal.document_id}`\n- Базовая ревизия: `{proposal.base_revision}`\n"
                        f"- Автор предложения: `{user.user_id}`"
                    ),
                    "remove_source_branch": True,
                },
                allowed_statuses=frozenset({400, 409, 422}),
            )
            if response.status_code >= 300:
                # The duplicate-MR answer is undocumented: an existing MR for the branch is the only
                # acceptable explanation; anything else is a real error.
                existing = await self._find_mr(branch)
                if not existing:
                    raise GitLabError(
                        "gitlab_bad_request",
                        f"GitLab не создал Merge Request (HTTP {response.status_code}).",
                        400,
                    )
                return PublishResult(
                    state="unchanged",
                    external_id=str(existing.get("iid")),
                    external_url=existing.get("web_url"),
                    message="Merge Request для этого предложения уже существует.",
                )
        except GitLabError as exc:
            raise PublisherDisabledError(exc.code, exc.message) from exc
        mr = response.json()
        logger.info("merge request opened for proposal %s", proposal.proposal_id)
        return PublishResult(
            state="created",
            external_id=str(mr.get("iid")),
            external_url=mr.get("web_url"),
            message="Merge Request создан; решение о merge принимают ревьюеры в GitLab.",
        )

    async def status(self) -> IntegrationStatus:
        return IntegrationStatus(
            name="gitlab_proposals",
            title="GitLab Merge Requests для предложений",
            kind="proposal_publisher",
            state="connected" if (await self._repository.status()).state == "connected" else "error",
            capabilities=["create_branch", "commit", "open_merge_request"],
            human_readable_message=(
                "Включено: предложение «Готово к ревью» можно отправить в MR. Merge выполняют только ревьюеры GitLab."
            ),
        )
