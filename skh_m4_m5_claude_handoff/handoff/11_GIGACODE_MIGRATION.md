# 11 — Подготовка к переносу AI на GigaCode

## Что нужно сохранить

Frontend editor, drafts, validation, proposal lifecycle, GitLab MR, Knowledge Provider, MCP provenance, publication queue и Confluence REST publisher — **вне AI-провайдера**. Меняется только реализация агентных функций.

## Контракт агентного авторинга

Input: request, document type/template, access scope, retrieved references+revisions, optional existing draft. Output: proposed Markdown, metadata suggestions, supporting citations, unsupported/unverified facts, warnings. AI не должен сам создавать approved document, merge MR или публиковать страницу.

## GigaCode в будущем

Может выступать клиентом/агентным runtime: читать git working tree или разрешённый API приложения, использовать Confluence MCP, формировать draft/patch, вызывать controlled tools на backend. **Не предполагать наличие публичного REST Agent API GigaCode**, пока не подтверждена корпоративная инсталляция. GigaChat API и GigaCode CLI/agent не одно и то же.

## Проверить при интеграции

Доступный GigaCode (IDE/CLI/on-prem), конфигурация MCP, project instruction files, способ автоматизированного вызова, tool approval, scopes, model data residency, поддержка авторизации пользователя. Для demo режима сейчас не использовать внешние LLM API.

## Документация

В конце обновить фактический `docs/GIGACODE_MIGRATION.md`: текущие interfaces, точки входа AI authoring, tool permissions, что потребуется подтвердить на сервере, ограничения до SSO и live validation.
