# 09 — Проверки и Definition of Done

## Базовый регресс

Сохранить все прежние backend/frontend/E2E тесты. Провести lint/format/typecheck, `make check`, `make preflight`, `make up`, `make e2e`, Docker health и network isolation; указать реальные результаты, не выдумывать.

## Авторинг (E2E-13…22)

- **13** ручное создание документа.
- **14** выбор шаблона и ожидаемая структура.
- **15** persistent draft после перезапуска.
- **16** дублирование ID/path блокируется без потери введённого текста.
- **17** предложение → готово к review.
- **18** GitLab mock создаёт branch → `create` commit → MR.
- **19** повтор отправки не создаёт второй MR.
- **20** только confirmed merge + sync добавляет документ в KB и FTS.
- **21** demo AI не выдумывает факты/признаёт недостаток данных.
- **22** editor usable на mobile.

## Публикация (E2E-23…36)

- **23** merged+synced document → persistent publication job.
- **24** dry-run возвращает preview и **не пишет** в Confluence mock.
- **25** первая публикация создаёт одну новую страницу.
- **26** следующее утверждённое изменение обновляет ту же страницу и version.
- **27** идемпотентная повторная публикация без дублей/лишней версии.
- **28** ручное изменение Confluence → conflict, no overwrite.
- **29** 401/403 при публикации → понятная ошибка и целостное состояние.
- **30** server unavailable → job persists, GitLab merge stays intact.
- **31** timeout после успешной записи → reconciliation, no blind retry.
- **32** restart сохраняет job/mapping.
- **33** unmerged MR нельзя публиковать.
- **34** real Confluence write disabled by default; mock-only writes gated.
- **35** storage output соответствует поддержанным Markdown элементам; unsupported constructs дают предупреждения/ошибки.
- **36** неизвестный/чужой Page ID нельзя перезаписать.

## Unit/contract/integration tests

Уникальные IDs/paths, frontmatter, version checks, create/update, source provenance, stale cache, index deletion, MCP pagination/unknown tools, all REST error paths, markdown→storage sanitation, page-mapping, double submit, concurrency, unauthorized request, network isolation, CA check, secrets in logs. Stateful mocks обязаны соответствовать контрактам; replay fixtures сами по себе недостаточны для publication lifecycle.

## Завершение

Сквозная локальная демонстрация: manual/AI demo draft → validation → review → GitLab mock MR → merge → sync → Confluence dry-run → mock create → mock update → conflict case. Все тесты проходят и исходные сценарии не сломаны; точные результаты в отчёте.

## Не считается готовым

Реальные GitLab и Confluence integrations **not live validated** до отдельного staging-тестирования. Без SSO/RBAC, audit, ACL, network approvals — no multi-user production. Не скрывать skipped live tests.
