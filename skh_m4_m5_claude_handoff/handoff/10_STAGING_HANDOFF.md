# 10 — Что оставить для подключения корпоративных сервисов

## Принцип

Разработать адаптеры и локальные тесты сейчас, но **не подключать** реальные эндпоинты и **не писать** в Confluence в текущем задании. Итог — готовые конфиг-образцы, диагностические команды, runbook и короткий запрос инфраструктурной команде.

## GitLab

- Staging URL, project ID, default protected branch, documentation path.
- Corporate CA PEM; DNS/egress/proxy.
- Auth: для read `read_api` и роль Reporter или допустимый корпоративный эквивалент; для branch/commit/MR отдельный технический/пользовательский доступ уровня Developer + `api`, строго на тестовом проекте.
- Test repo только с синтетическими документами.
- Read-only smoke → отдельно разрешённые MR writes → conflict/reconciliation, всё с отчётом.

## Confluence MCP

- Endpoint/transport, auth/token delivery, TLS/CA, поддерживаемая версия протокола.
- Реальный вывод `tools/list` и обезличенные примеры search/read + metadata.
- Test space `[TEST]`, expected page URLs, модель ACL (`service_account` vs `per_user`).
- В `service_account` нет гарантии пользовательских прав: только ограниченный контур до SSO.

## Confluence Data Center REST

- Base URL и точная версия Confluence DC, test space key, parent page ID, отдельные publishing credentials, API permissions.
- Только тестовые страницы; согласованный ownership marker / content property.
- Version update/merge conflict/create retry/reconciliation на тестовом пространстве.
- Чётко запретить использование общекорпоративных space или реальной документации для write тестов.

## Security/operations

Требования к защищённому хосту, docker network egress на разрешённые endpoints, corporate CA, local secret files или vault, логирование и retention, health diagnostics, approvals от ИБ, резервное копирование mapping/jobs, порядок ротации токенов. Не передавать токены в отчётах, чате или Git.

## Готовые артефакты

`docs/M4_M5_INTEGRATION_READINESS.md`, `docs/STAGING_TEST_RUNBOOK.md`, `docs/CONFLUENCE_SYNC_RUNBOOK.md`, env templates без секретов, команды preflight + opt-in read-only live validation, отдельные явно gated staging write tests. Зафиксировать, какие особенности API требуют адаптации под реальный DC; не обещать «только подставить URL» без проверки.
