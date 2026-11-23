# 01 — Контекст, границы систем и архитектурные контракты

## Предыдущая реализация (по последнему отчёту; проверь в коде)

M0–M3 завершены, M4.5 реализован. Backend FastAPI, frontend React/TypeScript, SQLite FTS5, Docker Compose, pytest, Playwright. Имеются локальный knowledge provider, GitLab adapter, Confluence MCP reader, demo AI, индексация и lifecycle предложений. На предыдущем прогоне: backend 319 passed + 2 skipped, frontend 46 passed, E2E 16 passed. Реальные корпоративные интеграции не проверялись.

## Источники истины

| Система | Роль | Запись |
|---|---|---|
| GitHub | Исходный код, CI и документация приложения | Только локальные Git commits, без push |
| GitLab | Управляемые командные Markdown-документы, ревизии, MR | Только отдельные branches + MR; mock сейчас |
| Confluence Data Center через MCP | Знания других подразделений | Только чтение |
| Confluence Data Center через REST | Опубликованные командные документы | Только после merge и безопасного разрешения; сейчас mock |
| SQLite/локальные тома | Черновики, предложения, индекс, состояния публикаций | Локальная персистентность |
| GigaCode | Будущий AI-agent runtime | На данном этапе не подключать |

## Архитектурные интерфейсы

Переиспользуй текущие сервисы, избегай дублирования:

- `KnowledgeProvider` — чтение документов и конкретных ревизий, актуальность, sync.
- `Proposal/DocumentService` — CRUD черновиков, валидация, create/update, diff и lifecycle.
- `GitLabAdapter` — tree/files/commit/branch/MR с проверкой remote-state.
- `CorporateSearchProvider` — MCP discovery, search/read и provenance.
- `AIProvider` — демонстрационный authoring и будущая замена agent runtime.
- `PublicationService` + `ConfluenceRESTPublisher` + durable publication-state — новая M5 часть.

Не предполагай, что перечисленные классы названы именно так; следуй фактическим контрактам проекта.

## Документ vs предложение vs публикация

Это разные сущности с независимыми статусами. Черновик ещё не в основной GitLab-базе; MR сам по себе не означает merge; merged в GitLab не означает published в Confluence. Не объединяй три state machine в один статус.

## Метаданные и происхождение

Для документов фиксировать ID, title, type, section, owner (если есть), status, references, source, path, revision SHA, проверенную дату/версию когда доступны. Не придумывать отсутствующие свойства. В индексе и цитатах сохранять источник и revision; 401/403/404 кэш недоступных документов очищается (с учётом текущей реализации).

## Начальная настройка

Сохраняй имеющиеся названия env: например, `KNOWLEDGE_BACKEND`, `GITLAB_URL`, `GITLAB_KNOWLEDGE_PATH`, если они уже существуют. Не вводи параллельные переменные без причины. Любое изменение API описывай в `docs/API_CONTRACTS.md`, изменение архитектуры — в ADR.
