# 06 — Тестовые серверы и режимы запуска

## Четыре режима

1. `offline` (default): fixtures и demo AI; сеть не нужна, существующая изоляция Docker не ухудшается.
2. `integration_mock`: Stateful GitLab, MCP и Confluence DC REST mocks на внутренней Docker-сети; write в mock разрешён только в этом профиле.
3. `live_read_only` (подготовить конфигурацию и opt-in runbook, но **не запускать**): тестовый GitLab/MCP только чтение.
4. `live_write_staging` (подготовить строго gated конфигурацию, **не запускать**): отдельный тестовый проект GitLab и `[TEST]` Confluence space с явным разрешением.

## Stateful GitLab mock

Files/tree/commits/branches/MRs, merges, conflicts, revisions, unknown write result, pagination, auth failures, 429/5xx. Он должен хранить достаточное состояние для create → merge → sync, а не возвращать статичные `200`.

## MCP mock

Действительный shape MCP сообщений по конфигу проекта: initialize, tools/list (pagination), tools/call, search/read, unavailable/malformed/auth denied.

## Confluence Data Center REST mock

Spaces, parents, pages, storage body, versions, create/update, manually edited, content-mapping/marker, 409, timeout после успеха, response corruption. Shape должен соответствовать документированному DC REST, а не Cloud API.

## Compose и команды

Сохрани `make up`, `make check`, `make preflight`, `make e2e`. Добавь команды integration-mock, publisher dry-run, readiness checks, full E2E. Моки и DB доступны только внутри Docker test network; не пробрасывать публичные порты. Dev UI по умолчанию только `127.0.0.1:5173`.

## Конфигурация

Шаблоны env без секретов, токены из файлов только на runtime, CA PEM, разрешённые network destinations. Все проверки доступности помечаются `mock`, `not configured`, `not tested`, `live validated` без ложных статусов. Не допускать silent fallback с недоступного реального GitLab на fixtures.
