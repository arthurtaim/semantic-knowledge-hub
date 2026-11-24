"""Clearly labelled MOCK corporate connector for tests and demos of the "Corporate" scope.

Contains only synthetic pages: four built-in pages plus the synthetic Confluence corpus from
`fixtures/confluence_mock/pages.yaml` (M5.6.2, Appendix 7 §1). Simulates server-side ACL and space
allowlisting so that restricted pages never reach search results, citations or model context.

Scenario state (revoked access, deleted pages, new page versions) lives in a small JSON file that the
operator changes with `python -m app.tools.mock_confluence …`; it is re-read when it changes, so a running
backend sees the change without a restart. Nothing here ever contacts a network.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

from app.adapters.corporate.base import CorporatePage, CorporatePageNotFoundError
from app.domain.external_text import storage_to_text
from app.domain.models import IntegrationStatus, UserContext
from app.domain.text import analyze_query, term_matches_text, tokenize

logger = logging.getLogger("skh.confluence.mock")

MOCK_INSTANCE = "demo-wiki"
MAX_MOCK_BODY_CHARS = 20_000


@dataclass(frozen=True)
class _MockPage:
    page: CorporatePage
    allowed_users: frozenset[str] | None = None  # None = everyone with space access
    next_version: CorporatePage | None = None


def _page(page_id: str, space: str, title: str, body: str, allowed: set[str] | None = None) -> _MockPage:
    return _MockPage(
        page=CorporatePage(
            page_id=page_id,
            space=space,
            title=title,
            body=body,
            source_uri=f"mock-confluence://{space}/{page_id}",
            version="1",
            updated_at=datetime(2026, 11, 1, tzinfo=UTC),
            is_mock=True,
            instance=MOCK_INSTANCE,
        ),
        allowed_users=frozenset(allowed) if allowed is not None else None,
    )


BUILTIN_PAGES: tuple[_MockPage, ...] = (
    _page(
        "MOCK-1001",
        "DEMO",
        "[MOCK] Требования к описанию интеграций (синтетика)",
        "Синтетическая страница mock-коннектора, не политика банка. "
        "Каждое описание интеграции в демо-примере должно указывать владельца и дату последней проверки. "
        "Список передаваемых атрибутов фиксируется только после согласования с владельцем системы.",
    ),
    _page(
        "MOCK-1002",
        "DEMO",
        "[MOCK] Учебное определение семантического слоя (синтетика)",
        "Синтетическая страница mock-коннектора. Семантический слой в учебном примере — это уровень "
        "бизнес-определений поверх физических данных. Определение не описывает архитектуру банка.",
    ),
    _page(
        "MOCK-1003",
        "DEMO",
        "[MOCK] Страница с ограниченным доступом (синтетика)",
        "RESTRICTED-MOCK-MARKER: эта синтетическая страница доступна только другому пользователю. "
        "ARIS restricted mock content.",
        allowed={"another-user"},
    ),
    _page(
        "MOCK-9001",
        "PRIVATE",
        "[MOCK] Страница вне разрешённых пространств (синтетика)",
        "PRIVATE-SPACE-MOCK-MARKER: пространство не входит в allowlist. ARIS private mock content.",
    ),
)
# Kept for compatibility with older imports.
MOCK_PAGES = BUILTIN_PAGES

DEFAULT_MOCK_SPACES = ("DEMO", "ARCH", "OPS")


def _when(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _corpus_page(entry: dict[str, Any], body: str, version: Any, updated: Any) -> CorporatePage:
    text, _ = storage_to_text(body, max_chars=MAX_MOCK_BODY_CHARS)
    page_id = str(entry["page_id"])
    space = str(entry["space"])
    return CorporatePage(
        page_id=page_id,
        space=space,
        title=str(entry["title"]),
        body=text,
        source_uri=f"mock-confluence://{space}/{page_id}",
        version=str(version),
        updated_at=_when(updated),
        is_mock=True,
        status=str(entry.get("status") or "unknown"),
        instance=MOCK_INSTANCE,
        storage=body[: MAX_MOCK_BODY_CHARS * 4],
        labels=tuple(str(label) for label in entry.get("labels") or ()),
        canonical_document_id=entry.get("canonical_document_id") or None,
    )


def load_corpus(path: Path) -> list[_MockPage]:
    """Synthetic corpus pages. A missing file is fine (only the built-in pages are served)."""
    if not path.is_file():
        return []
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    pages: list[_MockPage] = []
    for entry in data.get("pages") or []:
        body = str(entry.get("body") or "")
        repeat = int(entry.get("oversized_repeat") or 0)
        if repeat and "<tr>" in body:
            # Oversized fixture: repeat the example rows (after the first one) to make a huge page.
            head, _, rows = body.partition("<tr>")
            first_row, _, rest = rows.partition("</tr>")
            body = head + "<tr>" + first_row + "</tr>" + (rest.split("</table>")[0] * repeat) + "</table>"
        allowed = entry.get("allowed_users")
        nxt = entry.get("next_version")
        pages.append(
            _MockPage(
                page=_corpus_page(entry, body, entry.get("version", 1), entry.get("updated_at")),
                allowed_users=frozenset(str(u) for u in allowed) if allowed else None,
                next_version=(
                    _corpus_page(entry, str(nxt.get("body") or ""), nxt.get("version"), nxt.get("updated_at"))
                    if isinstance(nxt, dict)
                    else None
                ),
            )
        )
    return pages


@dataclass
class MockState:
    revoked: set[str]
    deleted: set[str]
    updated: set[str]

    @classmethod
    def load(cls, path: Path | None) -> MockState:
        if path is None or not path.is_file():
            return cls(set(), set(), set())
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            logger.error(
                "mock confluence state unreadable: treating every page as revoked is not safe; ignored"
            )
            return cls(set(), set(), set())
        return cls(set(data.get("revoked", [])), set(data.get("deleted", [])), set(data.get("updated", [])))

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(
                {
                    "revoked": sorted(self.revoked),
                    "deleted": sorted(self.deleted),
                    "updated": sorted(self.updated),
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        os.replace(tmp, path)  # atomic: a reader never sees half a file


class MockCorporateConnector:
    name = "confluence_mcp"
    enabled = True

    def __init__(
        self,
        allowlisted_spaces: list[str] | None = None,
        *,
        corpus_path: Path | None = None,
        state_path: Path | None = None,
    ) -> None:
        self._spaces = frozenset(allowlisted_spaces or DEFAULT_MOCK_SPACES)
        self._pages: list[_MockPage] = [*BUILTIN_PAGES, *(load_corpus(corpus_path) if corpus_path else [])]
        self._state_path = state_path
        self._state = MockState(set(), set(), set())
        self._state_mtime: float | None = None
        self.calls = {"search": 0, "get_page": 0}

    @property
    def corpus_size(self) -> int:
        return len(self._pages) - len(BUILTIN_PAGES)

    def _current_state(self) -> MockState:
        if self._state_path is None:
            return self._state
        try:
            mtime = self._state_path.stat().st_mtime
        except OSError:
            mtime = None
        if mtime != self._state_mtime:
            self._state = MockState.load(self._state_path)
            self._state_mtime = mtime
        return self._state

    def _effective(self, entry: _MockPage, state: MockState) -> CorporatePage | None:
        page_id = entry.page.page_id
        if page_id in state.deleted or page_id in state.revoked:
            return None
        if page_id in state.updated and entry.next_version is not None:
            return entry.next_version
        return entry.page

    def _visible(self, entry: _MockPage, page: CorporatePage, user: UserContext) -> bool:
        if page.space not in self._spaces:
            return False
        if user.allowed_spaces is not None and page.space not in user.allowed_spaces:
            return False
        return entry.allowed_users is None or user.user_id in entry.allowed_users

    async def search(self, query: str, user: UserContext, limit: int = 5) -> list[CorporatePage]:
        self.calls["search"] += 1
        terms = analyze_query(query)
        if not terms:
            return []
        state = self._current_state()
        scored: list[tuple[float, str, CorporatePage]] = []
        for entry in self._pages:
            page = self._effective(entry, state)
            if page is None or not self._visible(entry, page, user):  # ACL BEFORE ranking/snippets
                continue
            title_words = tokenize(f"{page.title} {' '.join(page.labels)}")
            words = tokenize(page.body)
            score = sum(
                2.0 if term_matches_text(t, title_words) else 1.0
                for t in terms
                if term_matches_text(t, title_words + words)
            )
            if score:
                scored.append((score, page.page_id, page))
        scored.sort(key=lambda item: (-item[0], item[1]))
        return [page for _, _, page in scored[: max(0, limit)]]

    async def get_page(self, page_id: str, user: UserContext) -> CorporatePage:
        self.calls["get_page"] += 1
        state = self._current_state()
        for entry in self._pages:
            if entry.page.page_id != page_id:
                continue
            page = self._effective(entry, state)
            if page is not None and self._visible(entry, page, user):
                return page
        raise CorporatePageNotFoundError(page_id)

    async def status(self) -> IntegrationStatus:
        return IntegrationStatus(
            name=self.name,
            title="Confluence Data Center (MCP, только чтение)",
            kind="corporate_knowledge",
            state="mock",
            capabilities=["search_pages", "read_page"],
            human_readable_message=(
                "MOCK: синтетические страницы для проверки сценариев, не настоящий Confluence. "
                f"Разрешённые пространства: {', '.join(sorted(self._spaces))}. "
                f"Синтетический корпус: {self.corpus_size} страниц."
            ),
            details={
                "connector": "mock",
                "spaces": ",".join(sorted(self._spaces)),
                "corpus_pages": str(self.corpus_size),
            },
            target="local",
            access="read",
        )


def page_ids(pages: list[_MockPage]) -> list[str]:
    return [p.page.page_id for p in pages]


def with_version(page: CorporatePage, version: str) -> CorporatePage:
    return replace(page, version=version)
