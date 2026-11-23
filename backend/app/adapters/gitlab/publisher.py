"""GitLabMRPublisher: turns a reviewed proposal into a branch + commit + Merge Request.

Safety rules (docs/GITLAB_KNOWLEDGE_WORKFLOW.md):
- never commits to the knowledge (default) branch: every write goes to `kb/update/<ID>-<suffix>`;
- one deterministic branch per proposal; an existing branch is reused only if it holds nothing but
  this proposal's commit, otherwise it is left untouched and the submission fails;
- GitLab's `last_commit_id` precondition guarantees a changed file is never overwritten;
- writes (POST) are never retried automatically; after a timeout or a lost answer the actual state
  (branch, commit trailer, MR) is inspected before anything is written again;
- one MR per proposal: an existing MR of the branch (opened, merged or closed) is always reused;
- the MR is a request for human review. Merge happens only in GitLab, by reviewers.
"""

from __future__ import annotations

import logging
import re
from typing import Any, cast
from urllib.parse import quote

from app.adapters.gitlab.client import GitLabClient, GitLabError, json_body
from app.adapters.gitlab.repository import GitLabKnowledgeRepository
from app.adapters.knowledge.base import RepositoryUnavailableError
from app.adapters.publishers.base import (
    MergeRequestRef,
    ProposalForPublication,
    PublicationError,
    PublishResult,
)
from app.domain.models import IntegrationStatus, UserContext
from app.domain.proposals import MergeRequestState

logger = logging.getLogger("skh.gitlab.publisher")

BRANCH_PREFIX = "kb/update/"
TRAILER = "Proposal-Id"
_SAFE_REF_CHARS = re.compile(r"[^A-Za-z0-9._-]+")
_MR_STATES: frozenset[str] = frozenset({"opened", "merged", "closed", "locked"})
# Outcomes where the write may have happened although no success answer arrived.
_UNCERTAIN_CODES = frozenset({"gitlab_timeout", "gitlab_unreachable", "gitlab_unavailable"})


def branch_name(proposal_id: str, document_id: str = "") -> str:
    """`kb/update/SEM-ARCH-001-1a2b3c4d`: readable, unique per proposal, stable across retries."""
    slug = _SAFE_REF_CHARS.sub("-", document_id).strip("-.")[:64]
    suffix = proposal_id[:8]
    return f"{BRANCH_PREFIX}{slug}-{suffix}" if slug else f"{BRANCH_PREFIX}{suffix}"


def _trailer(proposal_id: str) -> str:
    return f"{TRAILER}: {proposal_id}"


class GitLabMRPublisher:
    enabled = True

    def __init__(self, repository: GitLabKnowledgeRepository) -> None:
        self._repository = repository
        self._client: GitLabClient = repository.client

    @property
    def target_branch(self) -> str:
        return self._repository.branch

    def branch_for(self, proposal_id: str, document_id: str) -> str:
        return branch_name(proposal_id, document_id)

    # --- GitLab state inspection -------------------------------------------------------------
    async def _branch_exists(self, branch: str) -> bool:
        response = await self._client.request(
            "GET",
            self._client.project_path(f"/repository/branches/{quote(branch, safe='')}"),
            allowed_statuses=frozenset({404}),
        )
        return response.status_code == 200

    async def _branch_commits(self, branch: str) -> list[dict[str, Any]]:
        """Commits on the proposal branch that are not on the target branch."""
        response = await self._client.request(
            "GET",
            self._client.project_path("/repository/compare"),
            params={"from": self.target_branch, "to": branch, "straight": "false"},
        )
        payload = json_body(response)
        commits = payload.get("commits") if isinstance(payload, dict) else None
        if not isinstance(commits, list):
            raise GitLabError("gitlab_invalid_response", "GitLab вернул неожиданный ответ сравнения веток.")
        return [c for c in commits if isinstance(c, dict)]

    async def _branch_state(self, branch: str, proposal_id: str) -> str:
        """ "missing" | "empty" (created, nothing committed) | "committed" (holds our commit) |
        "foreign" (holds commits that are not this proposal's)."""
        if not await self._branch_exists(branch):
            return "missing"
        commits = await self._branch_commits(branch)
        if not commits:
            return "empty"
        ours = [c for c in commits if _trailer(proposal_id) in str(c.get("message", ""))]
        return "committed" if len(ours) == len(commits) else "foreign"

    def _mr_ref(self, item: dict[str, Any], branch: str) -> MergeRequestRef:
        state = str(item.get("state") or "")
        return MergeRequestRef(
            iid=str(item.get("iid") or ""),
            url=self._repository.merge_request_web_url_ok(item.get("web_url")),
            state=cast(MergeRequestState, state if state in _MR_STATES else "unknown"),
            source_branch=str(item.get("source_branch") or branch),
            target_branch=str(item.get("target_branch") or self.target_branch),
        )

    async def _find_mr(self, branch: str) -> MergeRequestRef | None:
        """Any MR (opened, merged or closed) for the proposal branch: a closed MR is a reviewer
        decision and must not be silently re-created."""
        response = await self._client.request(
            "GET",
            self._client.project_path("/merge_requests"),
            params={"source_branch": branch, "state": "all"},
        )
        items = json_body(response)
        if not isinstance(items, list):
            raise GitLabError("gitlab_invalid_response", "GitLab вернул неожиданный список Merge Request.")
        own = [i for i in items if isinstance(i, dict) and i.get("source_branch", branch) == branch]
        return self._mr_ref(own[0], branch) if own else None

    async def merge_request_state(
        self, proposal_id: str, document_id: str, iid: str | None
    ) -> MergeRequestRef | None:
        branch = self.branch_for(proposal_id, document_id)
        try:
            if iid and iid.isdigit():
                response = await self._client.request(
                    "GET",
                    self._client.project_path(f"/merge_requests/{iid}"),
                    allowed_statuses=frozenset({404}),
                )
                payload = json_body(response) if response.status_code == 200 else None
                if isinstance(payload, dict) and payload.get("source_branch") == branch:
                    return self._mr_ref(payload, branch)
            return await self._find_mr(branch)
        except GitLabError as exc:
            raise PublicationError(exc.code, exc.message, retryable=True) from exc

    # --- writes --------------------------------------------------------------------------------
    async def _create_branch(self, branch: str) -> None:
        try:
            response = await self._client.request(
                "POST",
                self._client.project_path("/repository/branches"),
                params={"branch": branch, "ref": self.target_branch},
                allowed_statuses=frozenset({400, 409}),
            )
        except GitLabError as exc:
            if exc.code not in _UNCERTAIN_CODES:
                raise
            response = None
        # "Already exists" is not documented, and a lost answer may hide a created branch:
        # decide by the branch's state, never by error text.
        if (response is None or response.status_code >= 300) and not await self._branch_exists(branch):
            raise GitLabError("gitlab_branch_not_created", "GitLab не создал ветку для предложения.")

    async def _commit(self, proposal: ProposalForPublication, branch: str) -> None:
        creating = proposal.operation == "create"
        action: dict[str, Any] = {
            "action": "create" if creating else "update",
            "file_path": proposal.document_path,
            "content": proposal.proposed_content,
        }
        if not creating:
            action["last_commit_id"] = proposal.base_revision  # GitLab rejects a stale base
        trailers = [_trailer(proposal.proposal_id), f"Operation: {proposal.operation}"]
        if not creating:
            trailers.append(f"Base-Revision: {proposal.base_revision}")
        payload: dict[str, Any] = {
            "branch": branch,
            "commit_message": (
                f"docs({proposal.document_id}): {'create — ' if creating else ''}"
                f"{proposal.reason.splitlines()[0][:100]}\n\n" + "\n".join(trailers)
            ),
            # Exactly one action on the document's own file: `create` of a new file or `update` of
            # the existing one. Never delete/move/chmod, never another path.
            "actions": [action],
        }
        await self._client.request("POST", self._client.project_path("/repository/commits"), json=payload)

    def _description(self, proposal: ProposalForPublication, user: UserContext) -> str:
        reason = proposal.reason.strip().replace("\r", "")[:1500]
        lines = [
            "Предложение изменения из Semantic Knowledge Hub. Требует ревью по правилам защищённой ветки;",
            "создание этого MR не означает утверждение изменения.",
            "",
            f"**Операция:** {'создание нового документа' if proposal.operation == 'create' else 'изменение документа'}",
            f"**Документ:** `{proposal.document_id}` — {proposal.document_title}".rstrip(" —"),
            f"**Файл:** `{proposal.document_path}`",
            f"**Базовая ревизия:** `{proposal.base_revision or '— (новый файл)'}`",
            f"**Изменения:** +{proposal.additions} / −{proposal.deletions} строк",
            f"**Автор предложения:** `{proposal.author or user.user_id}`",
            "",
            "**Причина изменения:**",
            "",
            *(f"> {line}" if line else ">" for line in reason.split("\n")),
            "",
            f"{_trailer(proposal.proposal_id)}",
        ]
        if proposal.proposal_url:
            lines.append(f"Предложение в приложении: {proposal.proposal_url}")
        return "\n".join(lines)

    async def _create_mr(
        self, proposal: ProposalForPublication, branch: str, user: UserContext
    ) -> PublishResult:
        try:
            response = await self._client.request(
                "POST",
                self._client.project_path("/merge_requests"),
                json={
                    "source_branch": branch,
                    "target_branch": self.target_branch,
                    "title": (
                        f"Draft: {'[новый] ' if proposal.operation == 'create' else ''}{proposal.document_id} — "
                        f"{proposal.reason.splitlines()[0][:80]}"
                    ),
                    "description": self._description(proposal, user),
                    "remove_source_branch": True,
                },
                allowed_statuses=frozenset({400, 409, 422}),
            )
        except GitLabError as exc:
            if exc.code not in _UNCERTAIN_CODES:
                raise
            response = None
        if response is not None and response.status_code < 300:
            created = json_body(response)
            if not isinstance(created, dict) or not created.get("iid"):
                raise GitLabError(
                    "gitlab_invalid_response", "GitLab вернул неожиданный ответ при создании MR."
                )
            logger.info("merge request opened for proposal %s", proposal.proposal_id)
            return PublishResult(
                state="created",
                merge_request=self._mr_ref(created, branch),
                message="Merge Request создан; решение о merge принимают ревьюеры в GitLab.",
            )
        # Duplicate answers are undocumented and a lost answer may hide a created MR: the only
        # acceptable explanation is an MR that exists for this branch.
        try:
            existing = await self._find_mr(branch)
        except GitLabError as exc:
            if response is None:  # the POST may have succeeded and we cannot see the result
                raise PublicationError(
                    "gitlab_write_uncertain",
                    "GitLab не подтвердил создание Merge Request, и проверить это не удалось. "
                    "Перед повторной отправкой состояние будет проверено в GitLab.",
                    uncertain=True,
                ) from exc
            raise
        if existing is None:
            if response is None:
                raise PublicationError(
                    "gitlab_write_uncertain",
                    "GitLab не подтвердил создание Merge Request; при повторной отправке состояние будет проверено.",
                    uncertain=True,
                )
            raise GitLabError(
                "gitlab_mr_rejected", f"GitLab не создал Merge Request (HTTP {response.status_code})."
            )
        return PublishResult(
            state="existing",
            merge_request=existing,
            message="Merge Request для этого предложения уже существует.",
        )

    async def publish_proposal(self, proposal: ProposalForPublication, user: UserContext) -> PublishResult:
        branch = self.branch_for(proposal.proposal_id, proposal.document_id)
        if not branch.startswith(BRANCH_PREFIX) or branch == self.target_branch:
            raise PublicationError(
                "gitlab_unsafe_branch", "Запрещено коммитить в основную ветку.", retryable=False
            )
        try:
            # 1. Idempotency first: an MR for this proposal means the work is done (or decided).
            existing = await self._find_mr(branch)
            if existing is not None:
                return PublishResult(
                    state="existing",
                    merge_request=existing,
                    message=f"Merge Request для этого предложения уже существует (состояние: {existing.state}).",
                )
            # 2. Branch: reuse only a branch that holds nothing but this proposal.
            state = await self._branch_state(branch, proposal.proposal_id)
            if state == "foreign":
                raise PublicationError(
                    "gitlab_branch_conflict",
                    f"Ветка {branch} уже существует и содержит чужие коммиты; она не будет перезаписана.",
                    retryable=False,
                )
            if state != "committed":
                # 3. Conflict check right before writing (the authoritative checks are GitLab's own:
                # the last_commit_id precondition of `update`, the "file exists" refusal of `create`).
                current = await self._repository.current_file_revision(proposal.document_path)
                if proposal.operation == "create" and current is not None:
                    return PublishResult(
                        state="conflict",
                        merge_request=None,
                        message=f"Файл {proposal.document_path} уже существует в GitLab; ничего не записано.",
                    )
                if proposal.operation == "update" and current != proposal.base_revision:
                    return PublishResult(
                        state="conflict",
                        merge_request=None,
                        message="Документ в GitLab изменился после создания предложения; ничего не записано.",
                    )
                if state == "missing":
                    await self._create_branch(branch)
                try:
                    await self._commit_safely(proposal, branch)
                except _Conflict:
                    return PublishResult(
                        state="conflict",
                        merge_request=None,
                        message=(
                            f"GitLab отклонил коммит: файл {proposal.document_path} уже существует. Ничего не записано."
                            if proposal.operation == "create"
                            else "GitLab отклонил коммит: файл изменился после создания предложения. Ничего не записано."
                        ),
                    )
            # 4. Merge Request.
            return await self._create_mr(proposal, branch, user)
        except RepositoryUnavailableError as exc:
            raise PublicationError(exc.code, exc.message) from exc
        except GitLabError as exc:
            raise PublicationError(
                exc.code, exc.message, retryable=exc.code not in ("gitlab_auth_failed", "gitlab_forbidden")
            ) from exc

    async def _commit_safely(self, proposal: ProposalForPublication, branch: str) -> None:
        try:
            await self._commit(proposal, branch)
        except GitLabError as exc:
            if exc.status == 400:
                # GitLab answers a stale `last_commit_id` (update) or an existing file (create) with a
                # generic 400: decide by state, never by message text.
                current = await self._repository.current_file_revision(proposal.document_path)
                if proposal.operation == "create" and current is not None:
                    raise _Conflict() from exc
                if proposal.operation == "update" and current != proposal.base_revision:
                    raise _Conflict() from exc
                raise GitLabError(
                    "gitlab_commit_rejected", "GitLab отклонил коммит предложения (400).", 400
                ) from exc
            if exc.code not in _UNCERTAIN_CODES:
                raise
            # The commit may have been applied although the answer was lost: look before retrying.
            try:
                applied = await self._branch_state(branch, proposal.proposal_id) == "committed"
            except GitLabError as inner:
                raise PublicationError(
                    "gitlab_write_uncertain",
                    "GitLab не подтвердил коммит, и проверить его состояние не удалось. "
                    "Повторная отправка сначала проверит ветку в GitLab.",
                    uncertain=True,
                ) from inner
            if not applied:
                raise PublicationError(
                    exc.code,
                    f"{exc.message} Коммит в GitLab не найден; отправку можно безопасно повторить.",
                ) from exc

    async def status(self) -> IntegrationStatus:
        repo_status = await self._repository.status()
        return IntegrationStatus(
            name="gitlab_proposals",
            title="GitLab Merge Requests для предложений",
            kind="proposal_publisher",
            state="connected" if repo_status.state == "connected" else "error",
            capabilities=["create_branch", "commit", "open_merge_request", "read_merge_request_state"],
            details={"target_branch": self.target_branch, "branch_prefix": BRANCH_PREFIX},
            human_readable_message=(
                f"Включено: предложение «Готово к ревью» отправляется в ветку {BRANCH_PREFIX}… и MR в "
                f"{self.target_branch}. Merge выполняют только ревьюеры GitLab."
            ),
        )


class _Conflict(GitLabError):
    def __init__(self) -> None:
        super().__init__("revision_conflict", "Документ в GitLab изменился после создания предложения.", 409)
