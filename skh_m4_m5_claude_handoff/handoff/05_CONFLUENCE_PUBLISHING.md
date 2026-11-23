# 05 — M5: Confluence Data Center REST Publisher

## Цель и правило записи

После подтверждённого GitLab merge и синхронизации конкретного файла по SHA: сформировать publication job → validation → **dry-run** → при отдельно разрешённой write-конфигурации создать/обновить Confluence DC страницу. **До разрешения все записи только на stateful mock.** Не использовать Cloud REST API и не использовать read-only MCP для записи.

## Компоненты

`PublicationService`, `ConfluenceDCRESTClient`, `MarkdownToStorageRenderer`, `PublicationStateStore` (durable), `PublicationQueue/Worker` (может быть локальным), `DocumentPageMapping`. Разделить от `KnowledgeProvider`, AI provider и MR lifecycle. Не вводить Redis/Celery без необходимости.

## Проверки до публикации

- Есть подтверждённый `merged` MR, commit SHA и документ в основной ветке GitLab.
- Документ валиден, статус допускает публикацию.
- Правильно определены target space и parent ID, они разрешены настройками.
- Есть write capability для test mock; у реального Confluence write disabled по умолчанию.
- Действует allowlist адресов и пространств, нет возможности задавать произвольный page ID пользователем.

## Конвертация Markdown

Конвертировать в Confluence **Data Center storage format**: headings, paragraphs, lists, tables, links, quotes, code blocks, inline code, bold, italic. Защитить от HTML/script injection, небезопасных URL; неподдерживаемые макросы, изображения и сложные диаграммы не терять молча: errors/warnings до публикации. Дать точный dry-run preview.

## Устойчивая привязка

Ключ: project ID + document stable ID / path. Хранить GitLab file path, published commit SHA, Confluence page ID, space key, parent ID, stored Confluence version, published content hash, last success time, state, sanitized last error. Для управляемых страниц использовать поддерживаемую marker/content property; не привязываться исключительно по заголовку. Не обновлять неизвестную/чужую страницу.

## Первая публикация

Проверить отсутствие mapping и чужого существующего документа, space/parent → render → dry-run → create page через DC REST (только safe mock сейчас) → persist ID/version/hash. Если create прошёл, но ответ потерян, сначала искать доказательство фактической страницы по устойчивому marker; нельзя создавать дубликат.

## Повторное обновление

Прочитать page ID, space/parent/version/storage, сравнить с последней успешно опубликованной версией. Если изменена вручную, создать конфликт и представить diff, **не перезаписывать**. Если unchanged и GitLab SHA/renderer output идентичны — no-op без новой версии. Иначе update с корректно увеличенным version number, проверка результата, сохранение версии/hash.

## Состояния и отказы

`not_published`, `pending`, `validating`, `dry_run_ready`, `publishing`, `published`, `outdated`, `conflict`, `failed`, `result_unknown` (или согласованные аналоги). Состояния независимы от статусов GitLab MR. Ошибка Confluence не откатывает GitLab merge. Retry только после анализа удалённого состояния; защищать один документ от параллельных публикаций и сохранять jobs после restart.

## Dry-run — обязателен

Показывать document ID + GitLab SHA, action create/update/no-op/conflict, target space/parent/page, converted storage preview, diff, warnings и проблемы. Никаких write-запросов, включая служебные, во время dry-run. UI action `Publish` недоступен, если write gated.

## Подготовка реального контура

`CONFLUENCE_PUBLISH_ENABLED=false` по умолчанию (согласуй с текущей конфигурацией). Для реального write дополнительно требовать явно подтверждённый staging mode, allowlisted host+space+parent, отдельные credentials, corporate CA, SSRF protection, журнал операции. Не использовать MCP-токен как publishing credential.

## Проверки mock

Stateful DC REST mock для spaces/pages/versions/parent/metadata/content, ручного изменения page, ошибок 400/401/403/404/409/429/5xx, lost response, idempotent repeated publishing и persistence after restart. Не подключать настоящий DC в рамках этой задачи.
