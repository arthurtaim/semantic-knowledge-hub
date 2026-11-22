"""Clearly labelled MOCK corporate connector for tests and demos of the "Corporate" scope.

Contains only synthetic pages. Simulates server-side ACL and space allowlisting so that
restricted pages never reach search results, citations or model context.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from app.adapters.corporate.base import CorporatePage, CorporatePageNotFoundError
from app.domain.models import IntegrationStatus, UserContext
from app.domain.text import analyze_query, term_matches_text, tokenize


@dataclass(frozen=True)
class _MockPage:
    page: CorporatePage
    allowed_users: frozenset[str] | None = None  # None = everyone with space access


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
        ),
        allowed_users=frozenset(allowed) if allowed is not None else None,
    )


MOCK_PAGES: tuple[_MockPage, ...] = (
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

DEFAULT_MOCK_SPACES = ("DEMO",)


class MockCorporateConnector:
    name = "confluence_mcp"
    enabled = True

    def __init__(self, allowlisted_spaces: list[str] | None = None) -> None:
        self._spaces = frozenset(allowlisted_spaces or DEFAULT_MOCK_SPACES)

    def _visible(self, entry: _MockPage, user: UserContext) -> bool:
        if entry.page.space not in self._spaces:
            return False
        if user.allowed_spaces is not None and entry.page.space not in user.allowed_spaces:
            return False
        return entry.allowed_users is None or user.user_id in entry.allowed_users

    async def search(self, query: str, user: UserContext, limit: int = 5) -> list[CorporatePage]:
        terms = analyze_query(query)
        if not terms:
            return []
        scored: list[tuple[int, str, CorporatePage]] = []
        for entry in MOCK_PAGES:
            if not self._visible(entry, user):  # ACL is applied BEFORE ranking/snippets
                continue
            words = tokenize(f"{entry.page.title} {entry.page.body}")
            score = sum(1 for t in terms if term_matches_text(t, words))
            if score:
                scored.append((score, entry.page.page_id, entry.page))
        scored.sort(key=lambda item: (-item[0], item[1]))
        return [page for _, _, page in scored[: max(0, limit)]]

    async def get_page(self, page_id: str, user: UserContext) -> CorporatePage:
        for entry in MOCK_PAGES:
            if entry.page.page_id == page_id and self._visible(entry, user):
                return entry.page
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
                f"Разрешённые пространства: {', '.join(sorted(self._spaces))}."
            ),
            details={"connector": "mock", "spaces": ",".join(sorted(self._spaces))},
        )
