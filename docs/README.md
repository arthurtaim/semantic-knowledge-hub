# Документация Semantic Knowledge Hub

Оглавление для команды. Обзор продукта и скриншоты — в [README репозитория](../README.md), итоги этапов — в
[reports/README.md](../reports/README.md). Правила для агентов разработки — [CLAUDE.md](../CLAUDE.md) и
[AGENTS.md](../AGENTS.md).

Документы с пометками M4…M7 описывают систему на момент соответствующего этапа и дополнялись по ходу работы. Описание
модуля в документе более позднего этапа главнее.

## С чего начать

| Документ | О чём |
|---|---|
| [PRODUCT.md](PRODUCT.md) | Требования к продукту: для кого, какие задачи решает |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Архитектура, адаптеры, технологические решения |
| [DECISIONS.md](DECISIONS.md) | Журнал архитектурных решений (ADR-001…049) |
| [API_CONTRACTS.md](API_CONTRACTS.md) | HTTP API; актуальная версия контракта — последний раздел (v0.10) |
| [SECURITY.md](SECURITY.md) | Требования безопасности и допущения |
| [PRODUCTION_BLOCKERS.md](PRODUCTION_BLOCKERS.md) | Что не позволяло промышленное использование прототипа |

## Пользователю

| Документ | О чём |
|---|---|
| [WORK_USER_GUIDE.md](WORK_USER_GUIDE.md) | «Работа»: проекты, задачи, Гант, навыки «Работы» в чате, «Создать задачу» |
| [DOCUMENT_CREATION_WORKFLOW.md](DOCUMENT_CREATION_WORKFLOW.md) | Новый документ: черновик → ревью → база знаний → публикация |
| [TEMPLATE_HUB.md](TEMPLATE_HUB.md) | Каталог шаблонов документов |

## Как устроено

**Знания и поиск**

| Документ | О чём |
|---|---|
| [DOCUMENT_SCHEMA.md](DOCUMENT_SCHEMA.md) | Схема документа: поля, статусы, жизненный цикл |
| [METADATA_AND_LINKS.md](METADATA_AND_LINKS.md) | Метаданные без YAML, WikiLinks, обратные ссылки |
| [DOCUMENT_TEMPLATES.md](DOCUMENT_TEMPLATES.md) | Шаблоны и генерируемый frontmatter |
| [SEARCH_SYNC_TEMPLATES.md](SEARCH_SYNC_TEMPLATES.md) | Поиск, синхронизация индекса, версии шаблонов |
| [KNOWLEDGE_GRAPH.md](KNOWLEDGE_GRAPH.md) | Граф знаний: типизированные связи и их источники |
| [MOCK_KNOWLEDGE_BASE.md](MOCK_KNOWLEDGE_BASE.md) | Синтетическая база знаний для демо и тестов |

**Ассистент**

| Документ | О чём |
|---|---|
| [ASSISTANT_INSTRUCTIONS.md](ASSISTANT_INSTRUCTIONS.md) | Политика встроенного ассистента: кто какие инструкции читает |
| [AI_WORKFLOWS.md](AI_WORKFLOWS.md) | AI-предложения с принятием по пунктам |
| [AI_AUTHORING_CONTRACT.md](AI_AUTHORING_CONTRACT.md) | Создание документа с помощью AI |
| [AI_NATIVE_TOOLS.md](AI_NATIVE_TOOLS.md) | Инструменты системы, которыми пользуется ассистент |
| [EXTERNAL_RAG.md](EXTERNAL_RAG.md) | Внешние источники из Confluence без импорта |
| [ADAPTIVE_RAG.md](ADAPTIVE_RAG.md) | Решение «искать ли в Confluence» для слабой модели |

**«Работа» (проекты и задачи)**

| Документ | О чём |
|---|---|
| [WORK_MANAGEMENT.md](WORK_MANAGEMENT.md) | Модель данных, планирование, права, производительность |
| [WORK_CHAT_SKILLS.md](WORK_CHAT_SKILLS.md) | Навыки «Работы» в чате и «Создать задачу» |

## Интеграция в контур банка

| Документ | О чём |
|---|---|
| [INTEGRATIONS.md](INTEGRATIONS.md) | GitHub, GitLab, Confluence DC, AI: режимы и параметры |
| [M4_M5_INTEGRATION_READINESS.md](M4_M5_INTEGRATION_READINESS.md) | Что нужно от инфраструктуры, ИБ и администраторов систем |
| [GITLAB_KNOWLEDGE_WORKFLOW.md](GITLAB_KNOWLEDGE_WORKFLOW.md) | GitLab как хранилище базы знаний: MR, ревью, синхронизация |
| [CONFLUENCE_PUBLISHING_ARCHITECTURE.md](CONFLUENCE_PUBLISHING_ARCHITECTURE.md) | Публикация документов в Confluence |
| [CONFLUENCE_MAPPING.md](CONFLUENCE_MAPPING.md) | Привязка документ → страница, версии |
| [CONFLUENCE_SYNC_RUNBOOK.md](CONFLUENCE_SYNC_RUNBOOK.md) | Регламент публикации для оператора |
| [STAGING_TEST_RUNBOOK.md](STAGING_TEST_RUNBOOK.md) | Проверка на тестовых GitLab и Confluence |
| [SSO_RBAC_REQUIREMENTS.md](SSO_RBAC_REQUIREMENTS.md) | Требования к единому входу и ролям |
| [GIGACODE_MIGRATION.md](GIGACODE_MIGRATION.md) | GigaCode как агентная среда разработки |
| [OPERATOR_RUNBOOKS.md](OPERATOR_RUNBOOKS.md) | Регламенты оператора: документы, шаблоны, оценка и откат поколения индекса, ссылки |

## Разработка

| Документ | О чём |
|---|---|
| [DEVELOPMENT.md](DEVELOPMENT.md) | Запуск, демо-сценарий, тестовые двойники, тесты, конфигурация, структура репозитория, API |
| [CLAUDE_CODE_CLI_INTEGRATION.md](CLAUDE_CODE_CLI_INTEGRATION.md) | Личный тестовый стенд с Claude Code CLI (только синтетика) |
| [UI_REDESIGN.md](UI_REDESIGN.md) | Задание и решения по интерфейсу v2 (исторический документ) |
| [ui-v2/specs/](ui-v2/specs/) | Спецификации интерфейса v2: визуальная система, ассистент, экраны, граф |
| [ui-v2/documents/specs/](ui-v2/documents/specs/), [ui-v2/planner/specs/](ui-v2/planner/specs/) | Спецификации «Документов» v2 и планировщика v2 |
| [superpowers/](superpowers/) | Дизайн и план последней функции («Создать задачу»), образец процесса |
| [../.claude/skills/](../.claude/skills/) | Навыки агента разработки: документы, синхронизация, шаблоны, оценка поиска |

## Официальные API

- GitLab: [repository files](https://docs.gitlab.com/api/repository_files/),
  [commits](https://docs.gitlab.com/api/commits/), [merge requests](https://docs.gitlab.com/api/merge_requests/).
- Confluence Data Center: [REST API и CQL](https://developer.atlassian.com/server/confluence/rest/),
  [версионное обновление страниц](https://developer.atlassian.com/server/confluence/rest/v1000/api-group-content-resource/).
- Claude Code: [инструкции проекта](https://code.claude.com/docs/en/memory), [настройки](https://code.claude.com/docs/en/settings).

Интеграция зависит от версий систем, установленных в банке. Учётных данных и внутренних адресов в репозитории нет.
