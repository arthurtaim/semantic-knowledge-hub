# AI-first knowledge workflows (M5.6.3)

```text
UI action (+ document / draft / selection / goal)
 -> AiWorkflowService: reader-scoped evidence (search, graph, links) + PINNED template from the registry
 -> AIProvider only for text (assist: improve / summarize; draft_document): mock | Claude CLI (personal test)
    | internal OpenAI-compatible API (GigaCode-ready); no tools, inputs are data
 -> typed proposal (items + evidence), stored with its base (draft version / revision / template version)
 -> person accepts chosen items -> applied to a DRAFT (an approved document gets an update draft)
```

| Kind | Input | Output | Accept applies |
|---|---|---|---|
| `draft_from_prompt` | prompt, title?, template_id? | recommended active template + alternatives with reasons, evidence-backed draft (unknown facts stay «Требует уточнения»), tags, related | new draft (`origin: ai_suggestion`) |
| `suggest_metadata` | draft or document | tags / summary / related_ids with evidence; owner is never proposed | chosen fields only |
| `improve_section` | section | proposed section text (diff) | that section only |
| `summarize` | selection or document | summary | the `summary` field |
| `explain` | selection / question | grounded answer with citations or «недостаточно данных» | — |
| `check_completeness` | draft or document | missing required sections of the PINNED version, empty sections, missing required fields, broken links | skeletons of chosen sections |
| `find_related` | draft or document | WikiLink proposals `[[ID|Title]]` with evidence (mentions, not business dependencies) | links in the related section |
| `explain_relation` | two documents | path with each edge classified: typed business edge / mention / temporary | — (link to the graph) |
| `impact_analysis` | document | plan: typed dependants first, then mentions, template | — (plan only) |

Rules: nothing is applied without Accept; reject changes nothing; a proposal whose base changed (draft saved
elsewhere, document revised, template got a new version, link target gone) is `invalidated` with 409
`ai_proposal_stale`. The AI never approves, merges, publishes or calls GitLab/Confluence. Retrieved text,
user text and template guidance are data. Proposals are audited (`ai_proposals` table) without the prompt
text (a hash only). Invalid model JSON is `ai_invalid_response`, never a proposal.

API: `POST /api/ai/proposals`, `GET /api/ai/proposals[?draft_id=&document_id=]`,
`GET /api/ai/proposals/{id}`, `POST /api/ai/proposals/{id}/accept {item_ids}`, `POST …/reject`.

The deterministic mock serves every workflow offline (`assist` quotes / normalizes, never invents);
live checks with the Claude CLI are opt-in and synthetic. Checks: `tests/test_ai_workflows.py`,
eval cases `KM-AI-*`.

## Навыки ассистента и вложения (UI v2, фаза C)

Навык — именованный сценарий с явным правом поверх тех же сценариев: реестр отдаёт
`GET /api/assistant/skills`, фронтенд список не зашивает; навык передаётся в `POST /api/assistant/ask`
(и `/ask/stream`) полем `skill_id`. Контракт: `docs/API_CONTRACTS.md` (v0.4), спецификация:
`docs/ui-v2/specs/02_ASSISTANT.md` §3–§6.

| Навык | Право | Основа | Нужно | Результат в диалоге |
|---|---|---|---|---|
| `answer` «Ответ по базе знаний» | чтение | `ask` | вопрос | ответ с цитатами (как раньше) |
| `explain` «Объяснить» | чтение | `ask` «Объясни: …» (как `explain`) | документ или выделение | ответ с цитатами, выделение цитируется первым |
| `summarize` «Кратко пересказать» | чтение | `summarize` | документ | сводка + ссылка на предложение |
| `check_completeness` «Проверить полноту» | чтение | `check_completeness` | документ | пробелы по закреплённой версии шаблона + предложение |
| `check_freshness` «Что перепроверить» | чтение | `impact_analysis` | документ | связанные документы, которые могли устареть, — план их проверки (ничего не применяется) |
| `find_related` «Найти связи» | чтение | `find_related` / `explain_relation` (два документа) | документ или вопрос | связи + ссылка на карту знаний |
| `compare_with_file` «Сравнить с файлом» | чтение | `ask` с вложениями | вложение | выдержки из базы и из файла раздельно; чего нет в базе — названо |
| `draft_document` «Черновик документа» | создаёт черновик | `draft_from_prompt` | описание | карточка предложения: шаблон, черновик, теги |
| `improve_section` «Улучшить раздел» | создаёт черновик | `improve_section` | документ и раздел (выделение) | карточка предложения с diff раздела |
| `suggest_metadata` «Предложить метаданные» | создаёт черновик | `suggest_metadata` | документ | карточка предложения по полям |

- Навык с правом «создаёт черновик» никогда ничего не применяет: создаётся AI-предложение (`/api/ai/proposals`),
  ответ несёт ссылку `proposal {id, kind, status}`; принять пункты или отклонить — отдельным действием человека.
  Навыки на основе сценариев требуют права `create_proposal`.
- Режимы ИИ: `internal_api`, `claude_cli` — доступны все навыки; `mock` — все, кроме `improve_section` (без языковой
  модели раздел не переписать; причина в одну строку приходит в `unavailable_reason`); `disabled` — ни одного,
  причина «ИИ отключён»; приложение работает как поиск.
- Что нужно навыку, реестр говорит в `requires`: `document`, `selection`, `attachment` и «одно из» —
  `document_or_question` (документ или выделение **или** вопрос от 3 символов; сейчас только у «Найти связи»). Без
  нужного поле не отправляет и пишет одну строку-подсказку; сервер отвечает `422 skill_input_missing` с
  `details.missing` (`document_or_question` для «одного из»).
- Сервер проверяет: навык существует и доступен в текущем режиме; нужные входные данные есть; выбранные документы
  видны; выделенный текст дословно есть в документе (иначе `422 selection_not_found`); вложения принадлежат этому
  диалогу и не просрочены (иначе `404 attachment_not_found`).
- Выбранный пользователем контекст («@документ», выделение) идёт в модель первым и цитируется первым, если относится
  к вопросу.

Вложения (`POST /api/assistant/attachments`, `DELETE /api/assistant/attachments/{id}`):

- до 10 файлов на диалог, до 20 МБ каждый; md, txt, csv, json, yaml/yml, sql, pdf, docx, xlsx; извлекается только
  текст; исполняемое не принимается (по расширению и по содержимому), docx/xlsx с макросами и «zip-бомбы» отклоняются;
- отказ — объект вложения со `status: "error"` и `error_code` (`unsupported_type`, `too_large`, `limit_reached`,
  `unreadable`), ничего не сохраняется; при `AI_PROVIDER=disabled` загрузка недоступна (`503 assistant_disabled`);
- хранится только извлечённый текст (не исходный файл), виден только в своём диалоге, удаляется по сроку
  (`ATTACHMENTS_TTL_HOURS`, по умолчанию 24 ч) или по кнопке;
- вложения **не индексируются** в поиск базы знаний, не попадают в граф и в память поиска (discovery);
- в ответе вложения — отдельная группа доказательств (`source_type: "attachment"`, имя файла, место: «строка 1»,
  «стр. 4», «лист Fields, строка 12»); цитата проверяется дословно по тексту файла, место вычисляет сервер; ответ,
  подтверждённый только вложением, не бывает «Подтверждено источниками» (максимум «Частично подтверждено»);
- демо-режим (`mock`) приводит из файла только дословные строки (заголовок и строки со словами вопроса), без выводов.
