# Semantic Knowledge Hub — пакет задания Claude Code (M4.6 + M4 + M5)

Этот пакет **добавляется** в существующий репозиторий приложения. Он **не заменяет** `CLAUDE.md`, `AGENTS.md`, `README.md`, текущие `docs/`, код и тесты.

## Порядок действий

1. Скопировать директорию `handoff/` в корень существующего репозитория.
2. Запустить Claude Code из корня репозитория.
3. Передать команду:

> Прочитай существующие `CLAUDE.md`, `AGENTS.md`, `README.md` и релевантные документы в `docs/`. Затем прочитай `handoff/00_START_HERE.md` и все перечисленные в нём документы. Реализуй последовательно M4.6 → M4 integration mocks/readiness → M5 Confluence publishing. Не подключай реальные сервисы; всё проверяй локально через stateful mocks. Следуй acceptance criteria, исправляй ошибки, выполняй тесты. Не делай `git push` и не меняй `main`. Не останавливайся после плана — реализуй и проверь.

## Файлы, которые нужно передать Claude

| Файл | Содержание |
|---|---|
| `handoff/00_START_HERE.md` | Главная задача, последовательность, зависимости и границы работы |
| `handoff/01_CONTEXT_ARCHITECTURE.md` | Исходное состояние, роли GitHub/GitLab/Confluence/GigaCode и контракты |
| `handoff/02_DOCUMENT_AUTHORING.md` | Новые документы, шаблоны, редактор, черновики, AI-assisted authoring |
| `handoff/03_GITLAB_WORKFLOW.md` | create/update, ревизии, ветки, commits, MR и синхронизация |
| `handoff/04_CONFLUENCE_MCP.md` | Корпоративный поиск и чтение через MCP; только read-only |
| `handoff/05_CONFLUENCE_PUBLISHING.md` | M5: REST publisher, версии, привязки, очередь, конфликты, dry-run |
| `handoff/06_MOCKS_AND_ENVIRONMENTS.md` | Stateful GitLab/MCP/REST mocks, offline/integration/live профили |
| `handoff/07_UI_UX.md` | Сквозные сценарии и интерфейсы публикации |
| `handoff/08_SECURITY.md` | Изоляция, разрешения, ACL, секреты, fail-closed |
| `handoff/09_TESTS_AND_ACCEPTANCE.md` | Полное тестирование, E2E-13…36, Definition of Done |
| `handoff/10_STAGING_HANDOFF.md` | Что подготовить для будущего корпоративного тестового стенда |
| `handoff/11_GIGACODE_MIGRATION.md` | Границы AI-провайдера и будущий GigaCode |
| `handoff/12_DELIVERABLES.md` | Документация по завершении, Git, отчёт и ограничения |

## Отличие входных файлов от итоговых

Эти `handoff/*.md` — **спецификация для Claude**. После реализации Claude должен **создать/обновить** операционную документацию в `docs/`: `DOCUMENT_CREATION_WORKFLOW.md`, `DOCUMENT_TEMPLATES.md`, `AI_AUTHORING_CONTRACT.md`, `GITLAB_KNOWLEDGE_WORKFLOW.md`, `CONFLUENCE_PUBLISHING_ARCHITECTURE.md`, `CONFLUENCE_MAPPING.md`, `CONFLUENCE_SYNC_RUNBOOK.md`, `M4_M5_INTEGRATION_READINESS.md`, `STAGING_TEST_RUNBOOK.md`, `PRODUCTION_BLOCKERS.md`, `GIGACODE_MIGRATION.md`, а также API/architecture/test docs.

Названия выходных файлов нужно согласовать с существующей структурой `docs/`, не создавать дубликаты без необходимости.
