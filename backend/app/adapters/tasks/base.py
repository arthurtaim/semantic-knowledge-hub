"""TaskSystemAdapter placeholder. The team's task system is not yet chosen: never fabricate
roadmap items, dates or statuses."""

from __future__ import annotations

from typing import Protocol

from app.domain.models import IntegrationStatus


class TaskSystemAdapter(Protocol):
    enabled: bool

    async def status(self) -> IntegrationStatus: ...


class DisabledTaskSystem:
    enabled = False

    async def status(self) -> IntegrationStatus:
        return IntegrationStatus(
            name="task_system",
            title="Система задач / роадмап",
            kind="task_system",
            state="disabled",
            capabilities=[],
            human_readable_message="Не подключено: система задач команды ещё не согласована. Роадмап не отображается.",
        )
