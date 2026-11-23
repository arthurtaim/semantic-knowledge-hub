# 07 — Требования к интерфейсу

Сохрани существующий дизайн, русскую локализацию, desktop/mobile, безопасность Markdown. Не делай полную переработку существующего UI.

## Главная и каталог

Действие «Создать документ»; быстрый поиск, AI chat, разделы, недавно обновлённые, предложения требующие действий, статусы интеграций. Каталог: статусы, владелец, дата, source, revision, filters, sort, актуальность. Никаких вымышленных счётчиков.

## Authoring

Чёткий маршрут «Создать → Тип → Редактор → Сохранить draft → Validate → Preview → Review». Форма метаданных, автогенерация ID/path, inline validation. Editor + preview, индикатор unsaved state, подтверждение удаления/выхода, восстановление после restart. Ручной и demo-AI режимы должны приводить в один workflow.

## Proposal/MR

Показывать документ `create`/`update`, diff новых файлов как полный added file, отдельные статусы proposal и MR, ссылку GitLab при наличии, подтверждение merge только из GitLab. Технические детали веток доступны по запросу, не как главный UI для аналитика.

## Publication

На странице документа отдельный блок: GitLab revision, publication status, published revision, Confluence original URL, last published, error/warning. Для разрешённых actions — `Dry-run`, `View diff`, `Queue publish`, `Retry` с адекватными disable states. Если Confluence write disabled — не отображать publish как доступное действие. Отдельное ясное сообщение об изменении страницы вручную и необходимости разрешить conflict.

## Integrations

GitLab Knowledge, Confluence MCP, Confluence REST publisher, AI provider: настроен/не настроен; доступен/не доступен/не проверен; mock vs real; read vs write; last check. Ни один «зелёный» статус не должен возникать только от наличия адреса в env.

## AI

Демо не выдавать за настоящую LLM; только подтверждённые цитаты и явное «Недостаточно данных». На authoring этапе показывать `references`, недоказанные утверждения и ограничения доступа. Не смешивать корпоративный и командный источник.

## Accessibility и resilience

Keyboard navigation, focus states, labels, mobile, loading/empty/error states, корректный `409`, сохранение текста при ошибке API; без внешних CDN.
