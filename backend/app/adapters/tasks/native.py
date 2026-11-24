"""Status of the built-in M6 Work Management module (not an external integration: target `local`)."""

from __future__ import annotations

from app.domain.models import IntegrationAccess, IntegrationStatus
from app.work.permissions import LABELS, WorkAccessGate, WorkAccessMode

CAPABILITIES = [
    "projects",
    "tasks",
    "subtasks",
    "fs_dependencies",
    "gantt",
    "schedule_preview_apply",
    "audit",
]


class NativeTaskSystem:
    enabled = True

    def __init__(self, gate: WorkAccessGate) -> None:
        self._gate = gate

    @property
    def access(self) -> IntegrationAccess:
        return (
            "read_write"
            if self._gate.mode in (WorkAccessMode.local_operator, WorkAccessMode.membership)
            else "read"
        )

    async def status(self) -> IntegrationStatus:
        mode = self._gate.mode
        message = f"Встроенный модуль задач SKH (проекты, задачи, зависимости FS, Гант). {LABELS[mode]}."
        if mode == WorkAccessMode.read_only and self._gate.read_only_reason:
            message += f" {self._gate.read_only_reason}"
        return IntegrationStatus(
            name="task_system",
            title="Задачи и планирование (встроенный модуль)",
            kind="task_system",
            state="connected",
            capabilities=CAPABILITIES,
            human_readable_message=message,
            details={"mode": mode.value, "team_ready": "false"},
        )
