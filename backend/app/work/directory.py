"""Who a task can be assigned to (M6).

In the local single-operator demo there are NO team accounts: the selectable people are the server-defined operator
and a fixed set of SYNTHETIC fixture assignees — role names marked «(демо)», not people, not accounts and never a
security subject (assigning a task to one grants nothing). In the team-ready `membership` mode only active project
members of the real identity provider are assignable. A client can never add a person to this directory.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.domain.models import UserContext
from app.work.models import AssigneeRef

FIXTURE_ASSIGNEES: tuple[tuple[str, str], ...] = (
    ("demo-analyst", "Аналитик (демо)"),
    ("demo-architect", "Архитектор данных (демо)"),
    ("demo-engineer", "Инженер данных (демо)"),
    ("demo-qa", "Инженер качества данных (демо)"),
    ("demo-owner", "Владелец продукта (демо)"),
)
SYSTEM_ACTORS = {"system:demo-seed": "Демо-данные (синтетические)"}


@dataclass(frozen=True)
class AssigneeDirectory:
    operator: UserContext

    def local_assignees(self) -> list[AssigneeRef]:
        return [
            AssigneeRef(id=self.operator.user_id, display_name=self.operator.display_name, kind="operator"),
            *(AssigneeRef(id=i, display_name=n, kind="fixture") for i, n in FIXTURE_ASSIGNEES),
        ]

    def local_ids(self) -> frozenset[str]:
        return frozenset(a.id for a in self.local_assignees())

    def ref(self, user_id: str | None, *, members: frozenset[str] | None = None) -> AssigneeRef | None:
        if user_id is None:
            return None
        for item in self.local_assignees():
            if item.id == user_id:
                return item
        if members is not None and user_id in members:
            return AssigneeRef(id=user_id, display_name=user_id, kind="member")
        return AssigneeRef(id=user_id, display_name=user_id, kind="unknown")

    def actor_display(self, actor_id: str) -> str:
        if actor_id in SYSTEM_ACTORS:
            return SYSTEM_ACTORS[actor_id]
        ref = self.ref(actor_id)
        return ref.display_name if ref else actor_id
