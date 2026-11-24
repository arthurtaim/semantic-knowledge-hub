"""TaskSystemAdapter: the status seam of the task module in `GET /api/integrations/status`.

`NativeTaskSystem` (adapters/tasks/native.py) reports the built-in M6 Work Management module; `DisabledTaskSystem`
is used with TASK_SYSTEM=disabled. No external task system (Jira, Plane, …) is integrated: never fabricate roadmap
items, dates or statuses from one."""

from __future__ import annotations

from typing import Protocol

from app.domain.models import IntegrationAccess, IntegrationStatus


class TaskSystemAdapter(Protocol):
    enabled: bool

    @property
    def access(self) -> IntegrationAccess: ...

    async def status(self) -> IntegrationStatus: ...


class DisabledTaskSystem:
    enabled = False

    @property
    def access(self) -> IntegrationAccess:
        return "none"

    async def status(self) -> IntegrationStatus:
        return IntegrationStatus(
            name="task_system",
            title="Система задач / роадмап",
            kind="task_system",
            state="disabled",
            capabilities=[],
            human_readable_message="Модуль задач отключён конфигурацией (TASK_SYSTEM=disabled). Проекты и Гант не отображаются.",
        )
