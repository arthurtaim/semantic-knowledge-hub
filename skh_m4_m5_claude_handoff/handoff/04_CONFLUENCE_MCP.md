# 04 — Confluence Data Center через MCP (read-only)

## Роль

MCP только для чтения корпоративной документации других команд: discovery, search, read page, metadata, источники/ревизии/ссылки. **Для публикации использовать отдельный Confluence Data Center REST adapter** (`05_CONFLUENCE_PUBLISHING.md`).

## Обязательные функции

- MCP initialize/session handling, tools/list с пагинацией, tools/call для разрешённых read-only инструментов, close/session cleanup.
- Имена инструментов и форма ответа — исключительно из `tools/list` и конфигурации `CONFLUENCE_MCP_TOOL_MAP` / `CONFLUENCE_MCP_RESULT_MAP`; никаких догадок или hardcoded корпоративных названий.
- Запрос/ответ может содержать несколько пространств; каждая цитата сохраняет source type, original page ID, title, URL, подтверждённую revision если доступна, дословный supporting excerpt.
- Ошибки: MCP unavailable, 401/403, timeout, malformed response, missing tool, schema mismatch; показывать явный статус и не подменять результат фиктивным.

## Авторизация и границы

Текущий `service_account` нельзя автоматически трактовать как user-scoped ACL. Режим `per_user` оставить заблокированным до SSO и реального механизма authorization propagation. Нельзя индексировать корпоративные данные в общедоступный кэш без соблюдения прав; до этого только ограниченный тестовый single-user контур. Client-side allowlist MCP tools — дополнение, а не серверное разграничение доступа.

## Mock

Stateful/replay MCP сервер с `tools/list`, search/read, несколькими spaces, missing tools, auth denied, malformed payload, transient errors и версиями. Записывать только synthetic fixtures; не соединяться с настоящим корпоративным MCP.

## Readiness

Для будущего live validation запросить MCP endpoint, версию протокола/transport, auth, выход `tools/list`, sample response для поискового и page-read инструментов, source-link rules, space restrictions, CA и права. Все различия локализовать в MCP adapter mapping, не в UI.
