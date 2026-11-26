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
| `draft_template` | prompt (Template Studio) | a template structure (sections required/optional + hints, required fields, completeness rules, guidance) + similar existing templates | — via `/accept`; saved from the editor (below) |

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

## Template proposals («Создать с помощью AI» in Template Studio)

```text
/templates → «Создать с помощью AI» → prompt
 -> POST /api/ai/proposals {kind: draft_template}  (needs create_proposal AND create_template)
 -> TemplateStudioService: catalogue of ACTIVE templates (id, title, type, category, sections) as DATA
 -> AIProvider.draft_template (optional capability; app/adapters/ai/template_protocol.py: one system prompt, one
    delimited user message, a strict JSON reply) — internal_api, claude_cli; any chat model, no vendor logic
 -> the backend re-validates every value and REPLACES what it cannot accept, saying so in `warnings`:
    unknown doc_type → guide, metadata outside METADATA_FIELDS dropped, title always required, a taken / invalid
    template_id or ID prefix → a free one
 -> deterministic similarity with the catalogue (section titles, type, title words) + the model's `similar_to`
    claims that name real templates → «Похоже на существующий шаблон «…» (id): …»
 -> AiProposal {items: template (the spec), similar (note)}; stored and audited like every proposal (prompt hash only)
 -> «Открыть в редакторе»: the person edits the proposal (sections, flags, hints, rules…)
 -> «Сохранить черновик» = POST /api/templates/studio {spec, ai_proposal_id}: the person's version becomes a template
    DRAFT; the proposal is `applied` with `result_template_id`
 -> «Активировать» — a separate, confirmed step with its own right
```

- The AI never creates, saves or activates a template and has no access to the registry beyond the catalogue
  summary it is given. `/accept` refuses a template proposal (`409 ai_proposal_use_editor`); «Отклонить» changes
  nothing.
- The prompt and the catalogue are data: delimited, `<<<`/`>>>` escaped; instructions inside them are ignored. An
  unparsable reply is `502 ai_invalid_response`, never a proposal.
- `mock`: unavailable with one line («Без языковой модели структуру шаблона не предложить…», `503
  ai_template_unavailable`) — no fake structure; `disabled`: no button. Manual creation always works.
- Checks: `tests/test_template_studio.py::test_s8_*` (scripted model double, keyword logic only inside the double),
  `e2e/templateStudioAi.spec.ts` (projects `scripted`, `scripted-mobile`).

## Task-plan proposals («AI план», M6)

The same contract as the proposals above — a typed proposal with evidence, nothing applied without an explicit
Accept, a proposal whose base changed is invalidated, never merged silently — for TASKS of the work module. It lives in
`work.sqlite3` (`work_ai_proposals`) so that apply (tasks + dependencies + links + the status change) is ONE
transaction; it is created and applied only from the project UI (the chat has no write tool). Flow, validation
(cycles / unknown ids reject the plan; assignees, dates, invented sources and unverifiable quotes are dropped and shown
as review issues; dates are computed by the server), staleness (`plan_changed`, `source_changed`,
`source_unavailable`, `expired`) and the API: `docs/WORK_MANAGEMENT.md` §11, `docs/API_CONTRACTS.md` v0.7. Providers:
the optional `WorkPlanningAIProvider.plan_work` over the model-agnostic JSON protocol `app/adapters/ai/work_protocol.py`
(`internal_api`, `claude_cli`); `mock` and `disabled` have none, and the feature says it is unavailable.

## Change-set proposals of existing tasks (M7)

`propose_task_changes` (chat skill) and `POST /api/work-ai/change-proposals` create a typed change-set (WCP) of
EXISTING tasks — a third kind of proposal, separate from document AI proposals (`/api/ai/proposals`) and from task-plan
proposals (WAP, new tasks). The model proposes `{task_key, field, new_value, reason}` for the v1 allowlist (title,
description, status, priority, due_date); the server reads every `before` value and task version itself, drops unknown
tasks, unsupported fields and invalid values as review issues, stores nothing when nothing valid is left, and applies
the operations a person keeps in ONE transaction after re-checking the plan revision and every task version. A refinement
(WAP or WCP) is always a NEW proposal with `revised_from`. Details: `docs/WORK_CHAT_SKILLS.md`.

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
- режим без языковой модели (`mock`) приводит из файла только дословные строки (заголовок и строки со словами
  вопроса), без выводов.
