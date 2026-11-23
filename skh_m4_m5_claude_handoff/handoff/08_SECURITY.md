# 08 — Безопасность и эксплуатационные барьеры

## Неизменяемые запреты

Нет реальных банковских данных и корпоративных подключений без отдельного разрешения. Нет внешних AI API. Нет публичного сервера, `git push`, изменения `main`, токенов в репозитории, отключения TLS, внешнего CDN или записи в Confluence в обычном режиме. Не использовать Cloud API для Data Center.

## Идентификация и доступ

SSO/RBAC пока не реализованы: приложение остаётся в однопользовательском тестовом режиме. Каждое действие API должно иметь декларацию permission и fail-closed проверку. Нельзя заявлять per-user Confluence ACL при общем MCP service token. Граница полномочий проверяется до передачи текстов в модель и индекс. Тестовые security gates не равнозначны внедрённому SSO.

## Секреты и сеть

Секреты только через внешние read-only файлы/соответствующую систему секретов; корпоративный CA; HTTPS с проверкой сертификатов. HTTP допустим лишь для явно разрешённого loopback/mock транспорта. Endpoint allowlisting + host/DNS/IP controls, защита от SSRF/redirect to unapproved hosts, отсутствие proxy bypass; реальные network ACL обязаны устанавливаться инфраструктурой. Не логировать credentials, полные чувствительные URLs и содержимое документов без оснований.

## Данные и генерация

Документы, HTML, Markdown, результаты MCP — недоверенные данные. Никакого выполнения команд из текста, prompt injection, произвольных link/HTML injections и внешних изображений. Проверять filesize, path traversal, symlink escape, suspicious special files. Никаких подтверждённых AI-цитат без supporting excerpt и оригинального ID/revision.

## Write protection

Запись в Confluence при работе с настоящим хостом выключена по умолчанию. Отдельные credentials/URL/space allowlist, подтверждённая ownership-mapping, verified merged GitLab SHA, permissions, explicit staging gate, audit log. Разрешить write в локальный stateful mock только когда target является mock и отдельный тестовый профиль включён. Никакого auto-overwrite чужих или вручную изменённых страниц.

## Safety regression

Fail startup для небезопасных конфигураций; тесты на отказ auth, чужой Host, CSRF, injection, conflict, incorrect page ID, protected branch, network isolation, no tokens in logs. Обновить `PRODUCTION_BLOCKERS.md` и не снимать блокеры без реальных проверок.
