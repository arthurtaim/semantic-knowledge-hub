# UI redesign — ledger green

Task specification for Claude Code (and GigaCode later) to make the interface simpler, more consistent and
less templated, with a green visual identity. Functionality, Russian copy, accessible names and test
contracts stay unchanged unless a phase says otherwise. Phases 1–4 are implemented (phase 4, the AI-first entry
from the 2026 research: §5). **UI v2 (§6) supersedes the visual system of §2–§3**: new tokens with a dark theme,
Inter, a sidebar shell, the assistant as the main screen, the document and catalog layouts and the knowledge map.
§1–§5 stay as the record of what came before.

## 1. Audit of the previous UI (2026-11-23)

Reviewed at 1440×900 and 390×844 on every route (`/`, `/documents`, `/documents/:id`, `/documents/new`,
`/ask`, `/proposals`, `/proposals/:id`, `/proposals/new`, `/integrations`, 404).

| # | Weakness | Where | Severity |
|---|----------|-------|----------|
| W1 | 248 px dark sidebar holds five links and is ~70 % empty; it eats width on every page and becomes a dark block on phones | shell | high |
| W2 | Demo notice is a full-width diagonal-striped band, then repeated inside pages | shell, document, explorer | medium |
| W3 | Home is five identical boxed panels ("card kit"); nothing tells the eye where to start | home | high |
| W4 | Hero has three competing actions of similar weight (teal "Найти", black "Спросить →", outline "Создать") and an arrow suffix | home | medium |
| W5 | Every list title is an underlined accent link, so lists read as walls of links | home, explorer | medium |
| W6 | The document title is printed twice (page H1 and the Markdown H1) | document | medium |
| W7 | Passport column too narrow: revision hashes and URIs wrap mid-token | document | low |
| W8 | Lifecycle stepper is five bordered boxes; it reads as cards, not as a sequence | proposal, authoring | low |
| W9 | Selected states use near-black, primary uses teal, focus uses teal: three "active" colours | forms, filters | low |
| W10 | Pill-shaped chips (999px) next to 4 px buttons: inconsistent radii | ask, proposals | low |
| W11 | Navy/teal palette with no identity; brief asks for green | global | high |

## 2. Design direction

**Subject.** An internal registry of approved knowledge for a bank's semantic-layer team. The user's first
question about any document is "can I trust this?" (status, owner, review date, revision).

**Concept: ledger green.** A bound ledger's green cloth spine and ruled pages. Structure is drawn with
rules (lines), not boxes. The one loud element stays the **status stamp** (`StatusStamp`, `.stamp--large`
in the passport). Everything else is quiet.

### Tokens (`frontend/src/styles/app.css :root`)

| Token | Value | Role |
|-------|-------|------|
| `--bar` | `#143826` | top bar (ledger spine) |
| `--accent` | `#1d5c3c` | primary action, links, active tab |
| `--accent-ink` | `#12402a` | hover; text and border of a selected segment / chip / toggle (phase 4) |
| `--accent-wash` | `#e2eee5` | hover wash, current step, background of a selected control (phase 4) |
| `--accent-bright` | `#9fd3b0` | active nav underline and focus on the dark bar |
| `--paper` | `#f1f4ef` | page background (cool sage, not cream) |
| `--ink` | `#17231c` | text, section rules |
| `--line` / `--line-strong` | `#d6ddd4` / `#adbaaf` | rules (decorative) |
| `--line-input` | `#7d8a80` | boundary of a form control, ≥ 3:1 on every surface it sits on (phase 4) |
| `--info` / `--info-wash` | `--ink-soft` / `--surface-sunk` | plain information, neutral (phase 4) |

Statuses keep their own hues: in review `#345595` (blue belongs to review only), draft `#8a5a00` (dashed),
deprecated `#5f665f` (struck through; 5.07:1), danger `#a3332b`. Since phase 4 «Утверждён» is a quiet seal
glyph (muted `--approved` `#23683f`) with ink text in a neutral frame — approved is the normal state of the
base, and green is the interactive accent. State is always carried by text and shape too, never by colour
alone.

**Type.** Golos Text (Paratype, built for Cyrillic UI) for interface; PT Serif for document prose; JetBrains
Mono only for IDs, revisions and diffs. Scale unchanged (`--step--1 … --step-4`). Headings get −0.02em tracking.

**Shape.** One radius (`--radius: 3px`) for buttons, inputs, chips and tags. No gradients, no drop shadows.

### Rules for new UI

1. Group with rules and whitespace, not boxes. A bordered surface is reserved for things that are
   *objects*: the Markdown document, the passport, the diff, forms, integration cards.
2. One primary (filled green) button per view. Secondary actions are outlined; tertiary are underlined
   text buttons (`.button--quiet`).
3. List titles are ink-coloured and underline on hover; inline links in prose stay green and underlined.
4. Selected / pressed state = `--accent-wash` background with `--accent-ink` text (and border) and weight 600 —
   never a solid fill, which belongs to the one primary button (phase 4). Focus = 3 px `--accent` outline
   (`--accent-bright` on the bar).
5. Numbered markers only for real sequences (lifecycle, authoring steps).
6. No arrows appended to button text, no all-caps labels, no pill shapes.

## 3. Prioritised plan

### Phase 1 — shell, identity, home, lists (done)

- [x] W11 Green token set; favicon redrawn as the ledger mark.
- [x] W1 Sidebar → 56 px sticky top bar: brand, five nav links with an underline for the active one,
  identity at the right (hidden < 1180 px). Below 860 px: "Меню" button opens a vertical list.
  Accessible names, skip link and tab order unchanged.
- [x] W2 Demo notice is a slim single line aligned with the content column; text unchanged (`role="note"`).
- [x] W3/W4 Home: search is the hero; "Спросить ассистента" secondary, "Создать документ" tertiary,
  hint below. Two unequal columns: activity (recent, needs attention, proposals) and reference (sections,
  integrations). Sections are separated by heading rules, not cards.
- [x] W5 Ink-coloured list titles on home and explorer.
- [x] W6 Leading Markdown H1 hidden on the document page (title stays in the page header).
- [x] W7 Passport widened to 20.5 rem; accent top rule; sticky offset clears the top bar.
- [x] W8 Lifecycle stepper drawn as one ruled track (horizontal on desktop, vertical rule on phones).
- [x] W9/W10 Unified selected state and radius.

### Phase 2 — page-level simplification (done)

- [x] Document page: merge the in-page demo notice into the passport as a "Демо-документ" field, so the
  only demo notice above the fold is the bar (keep text matched by `document.test.tsx`). The field is the
  first passport row (label above the text) and keeps the original copy, including "Демо-данные.".
- [x] Explorer: collapse the meta row to `ID · Раздел · Владелец · Обновлён`; show "Источник" only when
  sources are mixed; move "Проверка" next to the stamp. With one source it is named once above the list
  ("Источник: …") and stays in each row as visually hidden text, so every result still carries its
  provenance for screen readers. The review flag is text plus a hollow ring. Pressed filter = `--accent-ink`.
- [x] Explorer on phones: filters into a `<details>` "Фильтры (n)" disclosure above results (below 860 px,
  `useMediaQuery`); closed by default, opened when a filter is active.
- [x] Integrations: two-column list (name + state | facts) instead of a three-column card grid; group
  "Не подключено" items under one heading. Order: error (needs attention) → connected → mock, then
  `h2` "Не подключено" and the disabled ones; server order kept within a state. Capabilities are a row of
  the facts `dl`. Rows are ruled, not boxed; one column below 860 px.
- [x] Proposal detail: put actions (mark ready / reject / submit) in a sticky right rail on ≥ 1100 px.
  Rail = "Действия" + MR panel (ruled, not boxed); buttons stacked: next step first, then "Продолжить
  редактирование", the submit hint, and destructive actions behind a rule. Narrower: the rail follows the
  lifecycle and notices, before the diff (DOM order, so tab order matches what is seen).

### Phase 3 — polish (done, dark scheme deferred)

- [x] Ask page: answer column 68ch with citations in a right rail on wide screens. ≥ 1200 px: each answer
  is a grid (answer 46 rem | its sources), answer lines ≤ 68ch inside the answer box; the question form
  lost its box (2 px ink rule above, fields on the paper); chips already use `--radius`. Also fixed: on
  ≤ 520 px the status stamp no longer widens the citation number column.
- [x] Authoring editor: align toolbar, save-state and pane labels to the ruled style. The Markdown toolbar is
  the top strip of the text field (1 px `--line` rules between commands, no per-button boxes, rows ruled
  when they wrap); both pane labels share one style; the empty preview is a ruled placeholder, not a dashed
  box; view toggle separators are `--line`, selected `--accent-ink`. Save state is text plus shape: ring
  (not saved yet, neutral, no longer green), filled dot (unsaved changes), tick (`save-state--saved`).
- [x] Dark-bar print stylesheet check. Document page in print: top bar, demo line, header actions, tabs and
  all buttons hidden; prose on the full width without its box; passport (with the "Демо-документ" caveat)
  after the prose; status stamp and ID stay under the title. Checked with print emulation at the A4 text
  width (680 px) and at 1440 px.
- [ ] Deferred: `prefers-color-scheme: dark` token set. Not part of this work order; it needs its own pass
  over the status hues, the stamp washes and the diff colours to keep text and shape contrast, plus
  screenshots of every route in both schemes.

## 4. Acceptance

- `npx tsc --noEmit`, `npx eslint .`, `npx vitest run` pass (102 tests at phase 1, 109 after phases 2–3).
- `npx playwright test` desktop, mobile and gitlab-mock projects pass (27 tests at phase 1 and after
  phases 2–3: desktop + mobile 17, gitlab-mock + gitlab-mock-mobile 10).
- No horizontal scroll at 360 px; keyboard focus visible on the dark bar and on paper.
- No changes to API calls, routes, accessible names or Russian copy that tests rely on.

## 5. Phase 4 — AI-first entry (UI/UX research, kept in git history)

Scope: the research roadmap sections «Quick wins» and «AI-first entry (on the current component set)», on the
current stack, without new UI libraries or backend changes. The audit in the research was made on the phase‑1
UI; every finding was re-checked on 2026-11-23 against the code of `feature/m56-adaptive-rag-graph` (M5.6.3)
and against screenshots of every route of `App.tsx` at 1440×900 and 390×844 in `AI_PROVIDER=mock` and
`AI_PROVIDER=disabled` (kept outside the repository).

### 5.1 Reconciliation of the research audit

Status: **актуально** (still true), **исправлено** (already fixed), **частично**, **н/п** (not applicable).

| # | Finding (research) | Status | Evidence | Phase 4 |
|---|---|---|---|---|
| F1 | No primitives layer, no icons | актуально | `frontend/src/components/` has domain widgets only; no Icon/Dialog/Menu | deferred (headless library + icons) |
| F2 | Many badge-like markers; a home proposal row has two bordered badges + reason + date | актуально | home screenshot: «Изменение документа» + «Новое» | deferred (two-axis StatusBadge, tokens v2) |
| F3 | Dashed border means «draft» for documents and «Новое» for proposals | актуально | `app.css` `.stamp--draft`, `.proposal-state--draft` | deferred (tokens v2) |
| F4 | Blue means both «in review» and plain info notices | актуально | `app.css` `.notice--info { border-color: var(--review) }` | **fix** (Q4) |
| F5 | Selected segments/filters are a solid dark-green fill next to the primary button | актуально | `/ask` screenshot («Команда» next to «Спросить»); `.segmented__option input:checked + span`, `.filter-option[aria-pressed]`, `.filter-chip[aria-pressed]`, `.view-toggle`, `.toggle-button`, `.graph-list__node` | **fix** (Q4) |
| F6 | Hex values bypass tokens (research: 14, `#fff` ×15) | актуально, worse | 35 hex values outside `:root` in `app.css` | deferred (tokens v2); no new hex in phase 4 |
| F7 | Near-black bar + full-width cream demo band on every page; band wraps to 4 lines on phones | частично | phase 1 made the band one line on desktop; mobile home screenshot: 4 lines, H1 pushed down | **fix** (Q3): band → striped «Демо» pill in the bar; bar colour stays until shell v2 |
| F8 | Demo message repeated 3× on a document page | частично | phase 2 merged it into the passport («Демо-документ»); still band + passport, plus a bottom notice in the explorer (`ExplorerPage.tsx:391`) | **fix** (Q3): pill + passport fact only |
| F9 | «Approved» uses the brand green, close to the primary button | актуально | `--approved: #23683f` vs `--accent: #1d5c3c`; `.stamp--approved` green fill | **fix** (Q4): quiet seal mark |
| F10 | 13 px dominates; 13 sizes outside the scale | not re-measured | — | deferred (tokens v2) |
| F11 | `font-weight: 700` without an imported Golos 700 (faux bold) | актуально | `app.css` `.citation__ref`, `.lifecycle__marker`, `.op-badge--create::before`, `.field__issue::before`; only 400/500/600 imported in `main.tsx` | **fix** (Q1): 600 |
| F12 | Proposal page: notices above, five-button action row ~1780 px down | исправлено | phase 2 sticky rail «Действия» (`ProposalDetailPage.tsx`) | — |
| F13 | Propose-change shows raw Markdown **with YAML front matter** | актуально | `ProposalEditorPage.tsx:232` «Текст документа (Markdown с YAML-заголовком)»; M5.6.3 removed YAML only from import and new documents | **fix** (Q6) |
| F14 | Two date formats on one screen; dates wrap in the proposals table | актуально | proposals table at 1440 px: «23 нояб. 2026 г., / 15:50» on two lines; `formatDate` vs `formatDateTime` side by side | **fix** (Q5) |
| F15 | 390 px: proposals table scrolls sideways; 9 filter chips wrap to 4 rows | актуально | mobile proposals screenshot | deferred (CollectionView, stacked rows) |
| F16 | Flat nav cannot hold ~10 destinations; no full-bleed layouts, overlays | актуально | `Layout.tsx` 7 links; `--content-max` on every route | deferred (shell v2) |

Accessibility findings (WCAG 2.2 AA), ratios re-computed with the WCAG 2.x formula:

| # | Finding | Status | Evidence | Phase 4 |
|---|---|---|---|---|
| A1 | «Устарел» `#737a74` on `#eceeeb` = 3.78:1 (1.4.3) | актуально | computed 3.78; `#5f665f` → 5.07 on the wash, 5.91 on white | **fix** (Q1) |
| A2 | Input/select/segmented borders `#adbaaf` = 2.02:1 on white, 1.82 on paper (1.4.11) | актуально | computed; `#7d8a80` → 3.61 white, 3.25 paper, 3.04 `--surface-sunk`, 3.02 `--accent-wash` | **fix** (Q1): new `--line-input` for control boundaries only |
| A3 | Sticky 56 px bar vs 24 px `scroll-margin-top` (2.4.11) | актуально | `app.css` `.prose h*`, `.citation` use `--space-5` | **fix** (Q2) |
| A4 | 404 and full-page errors have no H1 (1.3.1, 2.4.6) | актуально | `NotFoundPage.tsx` → `EmptyState` renders `<p class="feedback__title">`; same for document/proposal/publication/corporate/draft not found | **fix** (Q2) |
| A5 | Tabs lack arrow keys; mobile menu has no Esc / focus return (2.1.1) | актуально | `DocumentPage.tsx:359`, `DiffView.tsx:71` — `role="tab"` without key handling; `Layout.tsx` has no keydown handler | **fix** (Q2) |
| A6 | SPA navigation with unsaved edits has no in-app guard | частично | change drafts: confirm on «Отмена» + `beforeunload` (`ProposalEditorPage.tsx`); no router blocker (needs a data router = route change) | deferred |
| A7 | States use shape as well as colour | исправлено/keep | stamps: dashed, struck-through, dot | keep, add the seal glyph |
| A8 | `prefers-reduced-motion` handled globally | исправлено/keep | `app.css` `@media (prefers-reduced-motion: reduce)` | keep |
| A9 | `--ink-faint` on `--surface-sunk` = 4.37:1 (new, not in the research) | актуально | computed | deferred (tokens v2); not used for text on sunk in phase 4 additions |

Screens the research did not audit (Template Hub, Import, Graph, AI proposals, M5.6.3), checked on screenshots:

| # | Finding | Status | Evidence | Phase 4 |
|---|---|---|---|---|
| N1 | `AI_PROVIDER=disabled`: `/ask` keeps an enabled «Спросить» that always fails with 503 «Интеграция недоступна» | актуально | disabled `/ask` screenshot; backend `assistant_disabled` | **fix** (E4): search-only page, no dead button |
| N2 | `disabled`: AI panels still render with a blocked notice (document page, draft editor) | актуально | `DocumentPage.tsx` `DocumentAiPanel`, `DocumentEditor.tsx` `DraftAiPanel` | **fix** (E4): hidden |
| N3 | `disabled`: «С помощью AI» radio is shown disabled on `/documents/new` | актуально | `DocumentCreatePage.tsx` `disabled={!aiAvailable}` | **fix** (E4): hidden, manual path only |
| N4 | `/proposals/new`: «В демо-режиме ИИ не генерирует правки» is also shown when AI is disabled | актуально | `ProposalEditorPage.tsx:188` (`ai_edit_suggestions` false in both) | **fix** (E4): mock → one-line reason; disabled → hidden |

### 5.2 Work checklist

Quick wins:

- [x] Q1 Contrast: `--deprecated: #5f665f`; `--line-input: #7d8a80` for inputs, selects, textareas, segments,
  filter chips, toggles, the view toggle and the Markdown toolbar (decorative rules keep `--line-strong`);
  faux-bold 700 → 600.
- [x] Q2 `html { scroll-padding-top: bar height + 16 px }`; `ErrorState`/`EmptyState` take `page` and render
  the title as the H1 (404, document, proposal, publication job, corporate page, template, proposal editor);
  APG arrows/Home/End with a roving tabindex on the document and diff tabs (`lib/tabs.ts`); Esc closes the
  mobile menu and returns focus to «Меню».
- [x] Q3 A quiet tool row under the bar holds the AI-mode chip and the striped «Демо-данные» tag; each opens a
  popover (Esc returns focus). The full-width band and the explorer's bottom demo notice are gone; the
  document passport keeps its «Демо-документ» fact; the tag's wrapper is the page's one `role="note"` and
  contains «Демо-данные.». The chip names provider, model (when reported), state, scope and limits.
- [x] Q4 Selected = accent wash + accent-ink border/text + weight (segments, filter chips and options, view
  toggles, toggle buttons, graph list); «Утверждён» = seal glyph + ink text; `--info` neutral for info notices,
  «Новое», diff hunks, answered AI proposals and the internal-model label — blue stays with «На ревью».
- [x] Q5 `formatWhen` + `<When>`: «только что / N мин. назад / сегодня, 15:50 / вчера, 15:50», else a short
  date; full date as tooltip (and visually hidden for relative text); `nowrap`. Lists, tables, event logs,
  citations, integrations, templates. The passport and future moments keep absolute dates.
- [x] Q6 Propose change / edit change draft: «Текст документа» is the Markdown body (toolbar, `[[` links);
  the YAML header is kept byte for byte and summarised read-only («Метаданные документа»); «Показать
  исходный текст с YAML» for advanced edits.

AI-first entry:

- [x] E1 «Спросить или найти»: a field-like trigger in the tool row (not on the home page, whose hero is the
  same field) opens a modal palette; ⌘K / Ctrl+K and `/` (outside text fields) open it, the trigger carries
  `aria-keyshortcuts`. ARIA 1.2 combobox: debounced instant matches from `GET /api/documents?query=`
  (nothing preselected, a moving pointer only), «Спросить ИИ: «…»», «Все результаты поиска»; Enter asks
  (`/ask?q=…&run=1`, team scope) or searches; Tab switches modes while the list is open; visible mode
  buttons. `disabled` → search only, «Найти в базе знаний…».
- [x] E2 Home hero = the composer + «Где искать: Команда / Корпоративные / Оба» (team by default, a note when
  Confluence is not connected) + «Недавние вопросы» (last five, this browser only, «Очистить»). «Спросить
  ассистента» retired; tests and e2e updated in the same commit.
- [x] E3 Evidence first: support level (category + shape, no %) → «Доказательства» («Документы команды» and
  «Корпоративные источники» as separate lists) → «Объяснение» with [n] markers (hover/focus card: passage,
  document, source, status, revision; click opens the document at `section_anchor`) → «Открыть документ»,
  «Предложить правку по этому ответу», «Уточнить вопрос». Stages «Ищу источники → Формирую ответ →
  Проверяю цитаты». «Демо» on mock answers, «ИИ» on generated text. The conversation is kept in memory
  while the app is open, so following a citation and coming back keeps it.
- [x] E4 «В базе знаний нет ответа на этот вопрос»: what/where was searched, unmatched terms, the closest
  documents by the question's text (snippets, labelled as not evidence), three steps (refine; a separate
  corporate-only request when Confluence or its mock is available, else a one-line reason; «Создать
  черновик документа»). Modes: `disabled` hides every AI control (nav «Спросить», ask form, «Спросить ИИ об
  этих документах», «Спросить ассистента», AI panels, «С помощью AI», «Создать с ИИ», «Черновик от ИИ»);
  `mock` shows an unavailable AI edit disabled with a one-line reason.

### 5.3 Deviations from the research and gaps

- The composer sits in a tool row directly under the dark bar (with the chip and the demo tag) rather than
  inside the bar: the bar already holds brand + seven links + identity at 1440 px; a sidebar shell (v2) is
  deferred. The dark bar itself stays until shell v2 / tokens v2.
- Backend gaps (no backend change in phase 4): per-claim span verification and «Нет подтверждения в
  источниках» marks; partial matches of an insufficient answer are search snippets, not server-verified
  citations; the AI chip shows a model only when `/api/integrations/status` reports one (`internal_api`) and
  no retrieval limits are exposed; «Предложить правку по этому ответу» cannot pass the answer/instruction
  into the proposal (no API field; `ai_edit_suggestions` is off in mock); recent questions live in the
  browser until saved answers get a server-side decision.

Deferred (not in phase 4): tokens v2 / OKLCH, dark and high-contrast themes, headless library and icons,
sidebar shell v2, CollectionView, Peek, ⌘J context panel on every object, tasks / board / Gantt, AI delegates,
backend span-level citation verification, server-side saved answers. Open owner decisions: the accent green
(stays `--accent: #1d5c3c`; the research suggests `#18693f` or `#1f7a4d`), corporate sources only as a
separate labelled step.

### 5.4 Acceptance (phase 4)

- `npx tsc --noEmit`, `npx eslint .` clean; `npx vitest run`: 138 tests before phase 4 → 195 after.
- `npx playwright test`: desktop + mobile 25 passed, 1 skipped before → 26 passed, 1 skipped after (new
  E2E-13: Ctrl+K → question → evidence first → marker opens the section → back keeps the answer);
  gitlab-mock + gitlab-mock-mobile 10 passed.
- Screenshots of every route at 1440×900 and 390×844 in `mock` and `disabled`, before and after, kept outside
  the repository.

## 6. UI v2 — the new interface (phases A–F, 2026-11-24)

Task: the UI v2 handoff (kept in git history); specs `docs/ui-v2/specs/01_VISUAL_SYSTEM.md`, `02_ASSISTANT.md`, `03_SCREENS.md`,
`04_KNOWLEDGE_GRAPH.md`; mockups `docs/ui-v2/screens/design/`. Branch `feature/ui-v2-workspace`. Routes, existing API
contracts and the AI rules (`02_ASSISTANT.md` §6) are unchanged; the only new endpoints are those of `02_ASSISTANT.md`
§5 (the review round added only optional parameters and fields, §6.8). New dependencies: `@fontsource/inter` (frontend); `pypdf`, `python-docx`, `openpyxl` (backend, attachments);
`python-multipart` (backend, the attachment upload parser — allowed by the owner in the review round, §6.8).
Paths below without a prefix are under `frontend/src/`; `public/` and `e2e/` are under `frontend/`.

### 6.1 What changed, by phase

| Phase | What | Commits |
|---|---|---|
| A. Visual system | Colour tokens for light and dark in one block of `styles/app.css` (`tokens.test.ts`: no colour literal outside it, the two dark blocks identical, WCAG pairs); theme «Как в системе» / light / dark in the user menu (`lib/theme.ts`), applied before first paint by `public/theme-init.js`; Inter as the one typeface (Golos Text and PT Serif removed; JetBrains Mono only for Markdown source, diffs, code); `components/ui`: `Icon` (inline SVG from the mockup sources), `Button` / `IconButton`, `SegmentedControl`, `Chip`, `StatusMark`, `Popover` / `Menu` (APG keyboard), `Tooltip`; every existing screen moved onto the tokens | 4c37f92, a983929, 2125321, d4f2e2d |
| B. Shell | Left sidebar (logo and workspace, «Поиск ⌘K», Ассистент, Ревью, groups Знания / Работа / Система, user), icon rail (⌘\\), drawer below 960 px; the 52 px page toolbar with the path or title, page actions, the «Демо» badge and the AI-mode chip (`components/shell/*`, `lib/routes.ts`) | 3d2f9cb, 54cb82d, b74493b, 9422c9d, 353bf56 |
| C. Assistant | Backend: skills registry over the M5.6.3 scenarios, conversation attachments (md, txt, csv, json, yaml, sql, pdf, docx, xlsx; text only; per-dialog; TTL), new `ask` fields and the `attachment` citation (API v0.4, `docs/API_CONTRACTS.md`). Frontend: `Composer` (files by button / drag / paste, skills by button and «/», documents by button and «@», «Где искать», AI-mode label), the home page as the assistant screen, `/ask` as a dialog (markers in the text, citation card, one «Источники» block in three groups, excluded documents folded, pinned field), the ⌘K palette as `QuickFind` | 85d40d4, d7aff6b, 6546d1a, 5bd9f84, e2ee2d0, 2b21bfd, 78fa6ee, a2fb106, 4ce9cef, dbd51e9, 51e4f98, 66f23d0, e6208bf |
| D. Document, catalog, other pages | Document: status line, 30/36 title, properties grid, segments Текст / Связи / История / Markdown, «Сведения» panel, assistant panel (⌘J) with context chips, quick actions and the compact field, floating bar over a selection (Alt+F10). Catalog: table with groups and counts, filter chips and «+ Фильтр», Список / Таблица / Карта, phone card rows and a filter sheet. Templates, import, create, proposals, publication, corporate page, integrations and 404 in the toolbar / content / right-panel pattern | e8b707f, 325da89, 80b5d31, 915dfc6, 5be8e16, 3ac55e7, fa96c5b, 59d26bf |
| E. Knowledge map | Deterministic layout without overlaps (rings around a centre, unlinked nodes on an outer ring), type colours and shapes, label placement by priority, highlight of a node's neighbourhood, legend, node dragging with manual positions per view (`sessionStorage`), «Сбросить расположение», Alt+arrows (`docs/KNOWLEDGE_GRAPH.md`) | 6147ce9, cb7a152, bef9602, 45a0106, 5f3152d, 5c1e783 |
| F. Polish | Dark theme pass, phone 360 / 390 px, WCAG 2.2 AA audit and fixes, dead styles and exports removed, flaky tests made robust, this section (§6.4) | §6.7 |

### 6.2 Checklist — the UI v2 task §2 and the specs

Status: **сделано**, **частично** (what is missing is said), **нет**.

| Item | Status | Where |
|---|---|---|
| A · tokens as CSS custom properties, light and dark, theme from the system or chosen | сделано | `styles/app.css` (token block), `lib/theme.ts`, `public/theme-init.js`, sidebar user menu «Тема» |
| A · Inter only (`@fontsource/inter`), Golos and PT Serif removed | сделано | `package.json`, `styles/fonts.css` |
| A · `Icon` from the mockup sources (inline SVG, no library) | сделано | `components/ui/Icon.tsx` |
| A · Button (primary / secondary / quiet / icon), SegmentedControl, Chip, StatusMark, Popover / Menu, Tooltip | сделано | `components/ui/*`; since phase F the map and the create page use `SegmentedControl` too (one segmented style) |
| A · no hex outside the tokens | сделано | `tokens.test.ts` («uses no colour literal outside the token definitions») |
| 01 · CiteMarker, SourceBadge | частично | markers are `CitationMarker` / `.cite-pill` (`AnswerParts.tsx`); the source is a group heading and a meta line, not a separate badge component |
| 01 · type scale, radii, 4 px grid, shadows only on floating layers and the field, focus ring, motion 120–180 ms, reduced motion | сделано | token block; `@media (prefers-reduced-motion: reduce)` turns animations and transitions off |
| 01 · contrast: text 4.5:1, field boundaries and marks 3:1 | сделано | `tokens.test.ts`: 81 pairs per theme (deviations §6.5) |
| B · sidebar: logo and workspace, «Поиск Ctrl K», Ассистент, Ревью, Знания (Документы, Карта знаний, Шаблоны), Работа (Предложения, Публикации), Система (Интеграции), user | сделано | `components/shell/Sidebar.tsx`, `lib/routes.ts` |
| B · collapse to icons; below 960 px a slide-over with Esc, focus return, scrim | сделано | `Layout.tsx`, `Sidebar.tsx`; `a11y.test.tsx` |
| B · 52 px toolbar: path or title, actions on the right (≤ 1 primary), demo badge, AI-mode chip | сделано | `components/shell/PageToolbar.tsx`; phase F: the path shortens and never runs under the badges |
| B · counts: Документы, Ревью (green badge), Предложения | сделано | numbers from the API only: «Ревью» = «Готово к ревью» except the reader's own (`GET /api/drafts?status=ready_for_review&exclude_own=true`), «Предложения» = open proposals (`?open_only=true`); each link opens the same list (§6.8) |
| C · home = assistant: title, one line, field ≤ 760 px, four quick skills, «Недавние диалоги», «Ждёт вашего решения»; `disabled`: «Что нужно найти?», search, no skills | сделано | `pages/HomePage.tsx` |
| C · `/ask` dialog: toolbar «Ассистент / вопрос», demo badge, «Новый диалог»; user bubble with chips; support level; markers and card; one main action, «Открыть документ», «Копировать с источниками»; «Источники» in three groups with the attachment caption; excluded documents folded; no duplicated quotes; pinned field; chips kept after sending | сделано | `pages/AskPage.tsx`, `components/AssistantTurn.tsx`, `AnswerParts.tsx`, `AnswerSources.tsx`, `lib/useComposer.ts` |
| C · unconfirmed claims underlined in amber | частично | the API does not mark claims: an amber line lists the terms the server reports as unconfirmed |
| C · states: stream stages, «Недостаточно данных», error with retry, conflict | сделано | `components/AssistantTurn.tsx`, `lib/useAssistantTurns.ts` |
| C · `Composer`: chips with «убрать», Backspace, placeholder, Enter / Shift+Enter, up to 8 lines, files (button, drag, paste) with states, skills («/»), documents («@»), «Где искать», AI label, 34 px send disabled while reading, empty or while the skill's input is missing (§6.8) | сделано | `components/Composer.tsx`, `ComposerPalette.tsx`, `lib/useComposer.ts`, `composer.test.tsx` |
| C · attachment limits (10 per dialog, 20 MB, formats, text only, per dialog, expiry, delete) | сделано | `backend/app/services/attachments.py`, `backend/app/api/assistant.py` |
| C · skills from the backend registry over `AiProposalKind`; «создаёт черновик» never applies anything | сделано | `backend/app/domain/skills.py`, `services/skills.py`; `useSkills.ts`; «one of» requirement `requires.document_or_question` («Найти связи»: document or question; the field waits for one) |
| C · modes: everything in `internal_api` / `claude_cli`; `mock` disables skills without a deterministic implementation with a reason; `disabled` = search field | сделано | `aiModes.test.tsx`, e2e `assistant.spec.ts` |
| C · API: `GET /api/assistant/skills`, attachments POST / DELETE, new `ask` fields, `attachment` citations; pytest per endpoint | сделано | `backend/app/api/assistant.py`, `backend/tests/` |
| D · document toolbar: path, «Предложить изменение», «Ассистент» (pressed tone), «Ещё» | сделано | `pages/DocumentPage.tsx` |
| D · status line, 30/36 title, properties grid (Владелец, Раздел, Проверен, Источник, Ревизия, Связи); passport removed, all its fields kept | сделано | `DocumentPage.tsx`, `components/DocumentDetails.tsx` («Все сведения») |
| D · segments Текст / Связи / История / Markdown; text Inter 16/27 ≤ 700 px; repeated H1 hidden | сделано | `DocumentPage.tsx`, `.prose` |
| D · floating bar over a selection (Объяснить / Найти связанные / Предложить правку), keyboard selection, Esc | сделано | `components/SelectionToolbar.tsx` (Alt+F10) |
| D · assistant panel 360–380 px (⌘J): context chips, quick actions, short conversation, compact field; closed by default, remembered; a sheet below 1200 px | сделано | `components/DocumentAssistant.tsx`, `components/shell/SidePanel.tsx`; «Сведения» is remembered the same way (one key per panel, at most one set); a panel the page reopens does not take the focus |
| D · publication, AI proposals block, links and WikiLinks kept | сделано | `DocumentPublication.tsx`, `DocumentLinks.tsx`; the AI proposals block moved into the assistant panel: «Ещё по документу» (summarize, completeness, metadata) and «Ждут решения» (earlier undecided proposals, Accept / Reject) — `DocumentAssistant.tsx`, `AskProposal.tsx` |
| D · catalog toolbar: «Документы 83», Список / Таблица / Карта, «Найти в списке», «Создать документ» | сделано | `pages/ExplorerPage.tsx` |
| D · filter chips, «+ Фильтр», «Группировка», «Вид» | частично | «Вид» holds only the sort (nothing else to set) |
| D · table: Название + ID, Статус, Владелец, Обновлён, Связи; 42 px rows, 36 px group rows with counts; whole row clickable; the view remembered | частично | no «Связи» column (the list API has no per-document link count); `components/CatalogTable.tsx` |
| D · catalog on a phone: card rows, filters in a sheet | сделано | `CatalogTable.tsx` (`cards`), `ExplorerPage.tsx` |
| D · other pages in the new system without logic changes | сделано | `pages/*` |
| E · canvas, node colours and shapes, status styles, labels with halo and priority, edges and arrows, highlight, legend, controls | сделано | `components/GraphCanvas.tsx`, `GraphDetails.tsx`, `pages/GraphPage.tsx`, `lib/graph.ts` |
| E · dragging (threshold, capture, rAF, click vs drag, no relayout, pan, wheel zoom), overrides, `sessionStorage`, pinned relayout, «Сбросить расположение», Alt+arrows with an announcement | сделано | `GraphCanvas.tsx`, `lib/graphPositions.ts`; `graphCanvas.test.tsx`, e2e `graph.spec.ts` |
| E · layout: no overlaps on the demo graph, isolated ring, local rings, answer graph around the question, 200 nodes ≤ 300 ms | сделано | `lib/graph.ts`; `graphLayout.test.ts` (CPU time since phase F) |
| F · dark theme on all screens | сделано | §6.4 |
| F · phone 390 px (and 360 px); 03 §6: sidebar behind «Меню», field full width, lists and tables one column, right panels as bottom sheets, no horizontal scroll at 360 px | сделано | §6.4; e2e `polish.spec.ts` F-01 |
| F · WCAG 2.2 AA | сделано (manual audit, no axe) | §6.4; `a11y.test.tsx`, `tokens.test.ts`, e2e `polish.spec.ts` |
| F · dead styles removed | сделано | §6.4 |
| F · this section with checklist and deviations | сделано | here |
| 02 §6 · AI rules (evidence first, quotes with a source, categories not percent, sources never mixed, nothing applied by AI, full app with `disabled`, «ИИ» / «Демо» labels) | сделано | `answer.test.tsx`, `aiModes.test.tsx`, `m563.test.tsx`, e2e |

### 6.3 Keyboard

| Keys | Where | Does |
|---|---|---|
| ⌘K / Ctrl+K, «/» outside a text field | everywhere | the «Спросить или найти» palette (`QuickFind`); Tab switches question / search while the list is open, ↑↓ choose, Enter, Esc |
| ⌘\\ / Ctrl+\\ | wide screens | collapse the sidebar to icons and back (remembered) |
| Esc | drawer, panels, menus, popovers, palette | close and return focus to the control that opened it |
| Enter / Shift+Enter | assistant field | send / new line |
| «/» at the start of the line, «@» | assistant field | skills list / document search; ↑↓, Enter chooses, Esc closes |
| Backspace in an empty field | assistant field | removes the last chip |
| ⌘J / Ctrl+J (any layout) | document page | open / close the assistant panel |
| Alt+F10 | document text with a selection | focus into the floating bar; arrows move inside it, Esc closes |
| ←→ / Home / End | segments, document and diff tabs, toolbars | move the choice (roving tabindex); ↑↓ / Home / End / a letter in menus (APG) |
| Tab, Enter / Space | knowledge map | reach and select a node |
| Alt+arrows (Shift: 40 px) | knowledge map, selected node | move the node by 10 px — the alternative to dragging (WCAG 2.5.7); «Узел перемещён» is announced |
| arrows; +, −, 0; Esc | knowledge map (canvas focused) | pan; zoom in, out, fit (also the buttons); clear the selection |

### 6.4 Phase F — audit and fixes

**How it was checked.** Screenshots of all 17 routes of `App.tsx` × `mock` / `disabled` × light / dark × 1440 / 390
px, plus 27 interactive states in dark at 1440 px and 11 at 390 px (palette, skill and document lists, «Где искать»,
citation card, excluded sources, demo and AI popovers, catalog filter / view menus, list view, «Ещё», «Сведения»,
assistant panel, selection bar, «Связи» / «История» / «Markdown», map hover, proposal diff, editor, AI create,
rail, disabled search, import preview, drawer). Playwright scripts outside the repository measured, at 360 and 390
px on 21 routes and 8 states, every element sticking out of the viewport and every box scrolling sideways; and, on
19 routes × both stacks × 1440 / 390 px, the number of H1s, `main` and named `nav` landmarks, duplicate ids, ARIA id
references, positive `tabindex`, unnamed controls (from the ARIA snapshot), targets under 24 × 24 px that are not
inline in text or spaced (2.5.8), and while tabbing 50–70 stops: a visible focus indicator and whether the focused
element is the top-most one at its centre (2.4.11). No new dependency (no axe); the lasting checks are unit and
e2e tests (below).

**Dark theme.** All screens were legible and on tokens; fixed:
- the chosen segment (segmented control, tabs, Список / Таблица, palette modes, wizard step) was darker than its
  track and read as pressed in — new `--bg-raised` (white in light, `#2E3531` in dark);
- the selection bar, tooltips and the map hint used `--bg-inverse` and turned light — new `--bg-floating-bar`,
  `--text-floating-bar`, `--line-floating-bar` keep them dark, framed in the dark theme;
- the native «Выберите файл» button stayed light grey — styled as a secondary button;
- the «Как в системе» token block had three diff tokens twice;
- 22 more pairs in `tokens.test.ts` (both themes): the new tokens, text on diffs, statuses and accent on a hovered
  row, accent text on the panel surfaces, secondary text on the accent wash.

**Phone (390 and 360 px).** Fixed:
- the toolbar path ran under the «Демо» badge at 600–960 px (and could leave «A.» at 360): crumbs before the current
  page shorten first, the path is clipped at its own edge, a container query shows only the current page when the
  room left by the actions is under 26 rem, labelled toolbar actions keep only their icon below 760 px, the AI chip
  shows «ИИ» on a phone (the mode stays in its accessible name);
- `/proposals` scrolled sideways inside its own box: card rows below 720 px (as the catalog);
- the import preview's field table scrolled sideways: a definition list below 720 px.
A document's own Markdown tables and code blocks may scroll inside their frame (the page never does); such a block
is a tab stop so it scrolls with the keyboard. The older smoke check read `documentElement.scrollWidth`, which
`body { overflow-x: hidden }` always keeps at the window width — e2e `polish.spec.ts` F-01 measures elements instead.

**Accessibility (WCAG 2.2 AA).** Every route has one H1 (some visually hidden, the document's Markdown H1 is
`display: none`), one `main`, named `nav` landmarks, no duplicate ids, no positive `tabindex`, no unnamed control.
Menus, popovers, tabs and segments follow the APG patterns of phase A (`ui.test.tsx`, `a11y.test.tsx`). Live
regions report async results (answer stages, search and palette results, saves, map moves). Fixed:
- 2.4.7 — the skip link was hidden under the sticky sidebar and toolbar when focused (z-index);
- 2.4.11 — on `/ask` focus moving back from the pinned field could land under it: `usePinnedBottom` publishes the
  field's height and `html { scroll-padding-bottom }` keeps focused controls above it (the toolbar already had
  `scroll-padding-top`);
- 2.5.8 — source titles, «Показать» (excluded documents) and the map's «why linked» node names were 20 px tall;
  a map node's ring is now its hit area;
- 4.1.2 — «Создать с ИИ» on a template pointed `aria-controls` at a panel rendered only when open;
- 1.4.3 — tertiary text on the selected template-history row was 4.23:1;
- 2.1.1 — wide document tables and code blocks are keyboard-scrollable.
Kept as they are: map nodes can be smaller than 24 px at the fit zoom — «Списком» on the same page is the
full-size equivalent (2.5.8 exception) and the zoom enlarges them; the «Показать» link-button sits in a sentence.
Reduced motion turns animations and transitions off (the spec allows fades; off is stricter). What the scripts
still flag was checked by hand and is not a defect: a segment's radio is visually hidden and its visible label
draws the focus ring; a map node's focus ring is drawn on its ring circle; document Markdown tables and code
blocks scroll in their own frame as tab stops.

**Dead code.** A script listed class selectors of `app.css` that no string or template literal in
`src/**/*.ts(x)` contains (templates such as `stamp--${status}` counted by their static prefix, each dynamic family
checked against its TypeScript union): 12 dead classes — `.citation__head` / `__meta` / `__excerpt` (old ask
page), `.home__create`, `.home__actions`, `.search-box(--compact)`, `.index-list`, `.scope-status`, `.flag--block`,
`.button--ask` (no such `Button` variant), `.graph-node--status-neutral` (never returned by
`nodeStatusClass`). A browser pass recorded which selectors match on all routes and states above (mock and
disabled, 1440 and 390 px); combinations that never matched were reviewed by hand
(most belong to states that need data, e.g. AI proposals, publication jobs, conflicts): `.result__title a` (the
title is the link) and `.proposals .page-head .button` (the action moved to the toolbar) were dead, and the 520 px
block repeated the base `h1` size. In all 27 selectors, 79 lines. `.popover--top` / `--start` are built by
`placementClass()` and `.md-image-placeholder` by the backend Markdown renderer — kept. Unused exports removed: `ORIGIN_ORDER`, `PROPOSAL_NEEDS_ACTION`, `isExternal`,
`insertAt`, `forgetDraft`, `clearWikiLinkPreviewCache` and the phase-4 wrappers `readRecentQuestions` /
`rememberQuestion` (tests now use the dialog API). `SegmentedControl` had no CSS and no users while the map and
the create page hand-wrote `.segmented`: it now renders that markup and both use it.

**Flaky tests.** Reproduced with 20 busy loops on 10 cores while the whole suite ran: «saves with POST, switches the
URL to the draft…» read the URL right after «Черновик сохранён» appeared, but React Router applies `navigate()` in a
transition — the test now waits for the URL (which must still switch). Waits for the debounced live check get the
editor's `CHECK_DELAY_MS` on top of the default 1 s. The 200-node layout budget (300 ms) is measured as the layout's
own CPU time (`process.threadCpuUsage`, else `process.cpuUsage`) instead of wall time scaled by a lagging load
average. Under the same load the suite then passed four times in a row, and five times in a row idle.

### 6.5 Deviations from the mockups and specs (each checked in the code)

Visual
- Field boundaries are darker than in the mockup: `--line-field` `#808A83` is 3.57:1 on white (3.14:1 on the
  sidebar) instead of the mockup's `#D7DCD8` 1.39:1 — WCAG 1.4.11. Decorative frames keep `--line-strong`.
- Tertiary text `#646D67` instead of `#6B746E` (4.24:1 on the sidebar) → 4.70:1.
- Dark values that the spec does not give are ours, tuned for contrast: the status marks and texts, `--danger`
  and `--danger-border`, badge, cite and graph colours, `--bg-raised` and the floating bar.
- The theme is applied before the first paint by `public/theme-init.js`: the production CSP blocks inline scripts.
- The selection bar, tooltips and the map hint are dark in both themes (the spec describes the light theme only).

Shell
- The AI-mode chip stays in the page toolbar (design-04 shows it in the assistant panel; the panel also names the
  mode). On a phone it reads «ИИ».
- The collapse button sits next to the logo (⌘\\).
- With AI disabled the first item is «Главная» (there is no assistant).
- «Ревью» opens `/proposals?status=ready_for_review&exclude_own=true` and its badge is that list's total — «Готово к
  ревью» except the reader's own proposals (owner's decision; the API still has no reviewer assignment «на мне»). In
  the single-user demo it is usually 0, so no badge. The proposals page shows it as «Ревью» with a «Кроме моих»
  toggle after the status chips.
- «Публикации» opens its own list page `/publications` (§6.11). Until then it opened the Confluence publisher row of
  the integrations page, so after a click «Интеграции» became current while «Публикации» still looked selected.
- «Предложения» counts and opens the open proposals (`/proposals?open_only=true`: draft, ready for review, being
  sent, in a GitLab MR, sending failed — not merged, rejected or conflict), owner's decision; the page has an
  «Открытые» chip next to «Все».
- Labelled toolbar actions keep only their icon below 760 px; the path shows only the current page when the
  toolbar is narrow.

Assistant
- Demo answers have no prose of their own: the quotes appear only in «Источники» (no duplication).
- No amber underline of sentences — the API does not mark claims; an amber line lists the terms the server reports
  as unconfirmed.
- The citation card highlights the question's words inside the quote (the API returns only the excerpt).
- Corporate markers are К1, К2…; attachment markers Ф1….
- The main action is «Предложить правку» with the target document named under it.
- The «Где искать» menu also holds the phase-4 options for drafts and deprecated documents.
- The drop overlay shows only the number of files (browsers do not expose sizes during a drag).
- The skill list has no letter badges and no «Все навыки» (there is no such page).
- On phones the field's tools and «Новый диалог» are icons only and the AI label is hidden.
- «Ждёт вашего решения» says «Готово к ревью», not «На ревью у вас», and lists only other people's proposals (the
  «Ревью» list).
- The skill `check_freshness` is «Что перепроверить» — «Покажет связанные документы, которые могли устареть»
  (owner's decision; `02_ASSISTANT.md` still says «Проверить актуальность»): it runs `impact_analysis`, which lists
  linked documents to re-check rather than checking freshness itself.
- «Найти связи» with neither a document nor a question: the send button is disabled, the placeholder asks for a
  question or a document and one line under the field says what is missing.
- Backend: uploads are parsed by `python-multipart`'s streaming parser under a hard byte cap checked before each
  chunk (not FastAPI's `UploadFile`, which spools to a temporary file without a size cap); `improve_section` is
  unavailable in `mock` (owner agreed); extra limits — 100 ready files per user, `ATTACHMENTS_TTL_HOURS` = 24; an
  answer cited only from attachments is capped at «Частично подтверждено».

Document and catalog
- «Обновлён» is the document's own front-matter `updated_at`; the synthetic fixtures got `updated_at` = their
  `reviewed_at` (79 documents), the 4 never-reviewed drafts have none and show «—» (§6.9).
- «Вид» holds only the sort.
- Group counts are per loaded page (≤ 100 rows).
- The revision is shown short, `sha256:02b52b3c`.
- Default view: table when browsing, list for a search, then the remembered choice.
- The «ИИ-помощник по документу» block is no longer under the text: it duplicated the assistant panel, so its
  actions are skills in the panel («Найти связанные», «Что перепроверить» and, under «Ещё по документу», «Кратко
  пересказать», «Проверить полноту», «Предложить метаданные»), their proposals open from the answer with Accept /
  Reject, and the document's earlier undecided AI proposals are a folded «Ждут решения: N» list in the panel. Without
  AI (`disabled`) the panel and all of this are absent.
- «Сведения» reopens on a wide screen when it was left open, like the assistant panel; a panel reopened on load
  does not take the focus.
- «Предложить правку» in `mock` opens the manual editor; «Объяснить раздел» without a selection explains the
  document.
- Proposals and the import preview become card rows / a field list on phones (the spec names only the catalog).

Map
- The mode segments are in the map's own bar, not in the 52 px toolbar.
- The relation chip is «Связь: все» (relation type), not «Связи: подтверждённые»: an origin filter would be a new
  filter, which the spec forbids; confirmed vs unconfirmed is shown by line style and the legend.
- Node shapes unchanged (as the spec says); the answer graph's radial rings add some edge crossings.

### 6.6 Open questions for the owner

1. ~~Allow `python-multipart` instead of the standard-library parser?~~ **Decided: yes** — pinned with hashes,
   streaming parser with the byte cap (§6.8).
2. ~~«Ревью»: which source — a reviewer assignment in the API, or keep «Готово к ревью»?~~ **Decided:** «Готово к
   ревью» except the proposals the current user created (`exclude_own`); badge, link and the home row alike.
3. ~~«Предложения» count: total, or proposals that need an action (which statuses)?~~ **Decided:** open proposals
   only (`open_only`: draft, ready_for_review, submitting, submitted_to_gitlab, submission_failed).
4. ~~«Проверить актуальность» is built on `impact_analysis`: is the wording right?~~ **Decided:** renamed «Что
   перепроверить» — «Покажет связанные документы, которые могли устареть»; the id stays `check_freshness`.
5. ~~`improve_section` stays off in `mock` (no language model): agreed?~~ **Decided: yes** — unchanged, verified.
6. ~~«Найти связи» needs a document or a question; the skills registry cannot express «one of»: extend it?~~
   **Decided: yes** — `requires.document_or_question`, `skill_input_missing` with `document_or_question`, the
   composer's send rule.
7. ~~A per-document link count in the list API (for the catalog's «Связи» column)?~~ **Decided: yes** — optional
   `link_count` in `GET /api/documents` and the «Связи» column (§6.9).
8. ~~Should a recent dialog restore its skill and files, not only the question?~~ **Decided:** the skill always;
   files while not expired, otherwise a grey «файл больше недоступен» chip that is never sent (§6.9).
9. ~~Should the document's «Сведения» panel be remembered like the assistant panel?~~ **Decided: yes** — remembered
   per browser, docked only, mutually exclusive with the assistant.

### 6.7 Phase F acceptance

Commits: 9352726 toolbar path; b8f32d1 proposals cards; 8355c76 import fields list; 9a8796e skip link, targets,
`aria-controls`; e272e0f pinned field and keyboard-scrollable blocks; 73bb023 dark tokens; 42bc422 one segmented
control; b133ea7 flaky tests; d72c774 unused exports; ba0b471 e2e `polish.spec.ts`; acecbec dead CSS; and this
section.

- `npx tsc --noEmit -p tsconfig.json`, `npx eslint .` clean. `npx vitest run`: 341 tests before phase F →
  346 after (29 files; new: proposal cards, import preview at two widths, keyboard-scrollable blocks,
  `usePinnedBottom`); five consecutive runs: 346 passed each (4.7–4.8 s).
- `npx playwright test` (desktop, mobile, gitlab-mock, gitlab-mock-mobile; `E2E_DISABLED_URL` set): 51 passed,
  1 skipped before → 55 passed, 1 skipped after (`polish.spec.ts` F-01…F-04).
- Screenshots of every route × `mock` / `disabled` × light / dark × 1440 / 390 px and 360 px, and the interactive
  states in dark (1440 and 390 px) and light, before and after — kept outside the repository.

### 6.8 Review round — the owner's answers (2026-11-24)

The owner answered open questions 1–6 and 9 (§6.6; 7 and 8 are in §6.9) and asked to fold the
document's AI block into the assistant panel. Commits on `feature/ui-v2-workspace`:

| Item | What | Commits |
|---|---|---|
| 1 · `python-multipart` | Pinned `0.0.34` with the wheel and sdist hashes (`requirements.lock`, also `requirements-dev.lock`, `pyproject.toml`). `app/api/multipart.py`: `FormReader` feeds request chunks to `python_multipart.MultipartParser` and checks the byte cap before each chunk; same `FormData` shape and error codes (`invalid_multipart`, `invalid_request`, `too_large`), field order tolerated, parts in memory only, the parser's texts and log warnings (they quote body bytes) never passed on; the stdlib splitter is removed | b78fcad |
| 2 · «Ревью» | `GET /api/drafts?exclude_own=true` (additive); badge, link (`/proposals?status=ready_for_review&exclude_own=true`) and the home «Ждёт вашего решения» row use it; the proposals page shows «Ревью» with a «Кроме моих» toggle | 1ac55a0, 0a8f574, 616b152 |
| 3 · «Предложения» | `GET /api/drafts?open_only=true` (open = `OPEN_STATUSES`: draft, ready_for_review, submitting, submitted_to_gitlab, submission_failed); the sidebar count and link use it; «Открытые» chip | 5eaac72, 226d7da |
| 4 · `check_freshness` | «Что перепроверить» — «Покажет связанные документы, которые могли устареть»; the panel's quick action follows; id unchanged | 0aa8083 |
| 5 · `improve_section` in `mock` | unchanged: unavailable with its reason (registry test; checked on the running `mock` stack) | — |
| 6 · «документ или вопрос» | `requires.document_or_question` (additive, only `find_related`), `422 skill_input_missing` with `details.missing = ["document_or_question"]`; the composer disables sending, asks for a question or a document in the placeholder and says what is missing in one line | 469ccdf, ec2f592, 6c5c674 |
| 9 · «Сведения» remembered | `DETAILS_OPEN_KEY` next to the assistant's key (`lib/storage`, try/catch), one panel at a time, docked only; a panel the page reopens does not take the focus | 011702d, 4449c52 |
| D · document AI block | it duplicated the panel: removed from under the text; «Ещё по документу» (summarize, completeness, metadata) and a folded «Ждут решения: N» (earlier undecided AI proposals, Accept / Reject in place) in the panel; nothing applies without Accept; absent with `disabled` | eb415c8 |
| e2e | C-02 waited for nothing before dropping a file (failed once on a cold dev server) | f2381c6 |

API changes (all additive, `docs/API_CONTRACTS.md` «v0.4 additions»): `GET /api/drafts` `exclude_own`,
`open_only`; `SkillInfo.requires.document_or_question`; `skill_input_missing` may report `document_or_question`
(was `document` for `find_related`); the `check_freshness` name and description.

Checks (this tree, real runs):
- Backend: `ruff check`, `ruff format --check`, `mypy app claude_worker` clean; `pytest` 597 passed, 6 skipped
  before → 616 passed, 6 skipped after (new: the streaming reader — chunking, field order, cap while streaming,
  64 KiB prefix, nine malformed bodies, no body bytes in the 422, no temporary file —, `exclude_own`, `open_only`,
  the «one of» requirement).
- Frontend: `tsc`, `eslint` clean; `vitest` 346 → 358 (29 files).
- E2E (desktop, mobile, gitlab-mock, gitlab-mock-mobile; `E2E_DISABLED_URL` set): 55 passed, 1 skipped before and
  after (on stacks restarted cold).
- Screenshots of home / document / proposals × `mock` / `disabled` × light / dark × 1440 / 390 px, and of the
  document panel with the moved actions, «Ждут решения», «Ревью», «Открытые», the «Найти связи» hint and the
  remembered «Сведения» — outside the repository.

### 6.9 Review round — map, excerpts, catalog, recent dialogs (2026-11-24)

Done in parallel on separate branches and merged into `feature/ui-v2-workspace` (merges c531103, c184554, f76600d).

**Knowledge map, «Вся база»** (4202c48, 689a6ac, edf2eb5, 5ffb00b, de69f74, 5a35cc6, a25f516). Kinds form regions
(`kindRegions`: plain documents in the middle, source systems, integrations, entities, datasets and templates around
them; `forceX`/`forceY` towards the region, links between two kinds at 0.2 strength; still synchronous,
deterministic, overlap-free, 200 nodes ≈ 100 ms CPU). Edges rest at opacity 0.18 and are fully drawn, with the
relation's name, only for the hovered or selected node (the others fade to 0.08; unconfirmed edges stay dashed).
Only the 15 most connected nodes, the selected and hovered node and their neighbours are named (`labelRank`; greedy
collision hiding by that priority; hidden names stay in `title` and the accessible name). The legend is one line by
default, expands on demand, is remembered in `localStorage`, and the map re-fits when it opens or closes unless the
user moved the view. «Поколение графа» left the bar for «Сведения об узле» (nothing selected) and the tooltip of the
node/edge count. «Вокруг узла» and «Граф ответа» keep their edges and name every node up to 40 (top 15 beyond).
Measured: shape overlaps 0; label overlaps 0 at rest, on hover and on selection (1440 × 900: 15 labels at rest).

**Evidence display** (ba719dc, a3e5b2e, b35cf14, d4bbb60). Excerpts from Markdown tables are readable:
`Citation.excerpt_parts` (additive) carries the verified quote's prose and the table rows it touches with the header
row, traced by the server word by word to the cited section's Markdown at the same revision. `excerpt` stays the
verbatim quote; section text, the search index and the provider input are unchanged (eval identical on all 200
cases). «Источники» shows a mini table (stacked «заголовок: значение» in a narrow column), the marker card shows rows
of cells joined by « — », and «Копировать с источниками» copies readable rows. The amber line is now «Не найдено в
документах: «…»» and never names function words (RU + EN `FUNCTION_WORDS`, a superset of the search stop words,
applied by the server to `unmatched_terms` and the demo notes); with nothing meaningful missing the line is not shown.
Follow-ups: a readable table input for LLM providers (needs a measured change of passage text); function words still
count in coverage.

**Catalog and recent dialogs** (a47868b, 9a26cc3, c42ce4d, 98a362d, 4faa8e0).
- Decision 7: `GET /api/documents` items carry `link_count` — distinct documents linked to the row in the reader's
  snapshot (declared relations, `related_ids` and inline links plus the documents pointing at it), the same number as
  the document page's «Связи», computed once per snapshot. The catalog has a right-aligned tabular «Связи» column;
  phone cards say «3 связи» / «нет связей».
- «Обновлён» showed the revision time — for the seeded local workspace, the moment the files were loaded. It now
  shows the document's own date, the optional front-matter `updated_at` (`metadata_updated_at` in the API), «—»
  without one; «Сначала новые» sorts by the same date (undated last, by title); the document page keeps the revision
  date as «Дата ревизии». No synthetic document carried `updated_at`, so 4faa8e0 sets it to the document's
  `reviewed_at` (79 documents); the 4 never-reviewed drafts have none and show «—» (`make mock-kb-validate` OK, eval
  unchanged).
- Decision 8: a recent dialog stores the skill (id and name), the dialog id, the attached files (id, name, size,
  summary, `expires_at`) and the chosen documents, additively in the same `localStorage` format. Reopening restores
  the field in that dialog: the skill chip from the registry, live files as chips, expired or deleted ones as a grey
  «файл больше недоступен» chip that is never sent (also after `attachment_not_found`); skill runs without a question
  are links; a plain question is asked again at once, anything with a skill or files waits for Enter.

Checks of the merged round (this tree, real runs):
- Backend: `ruff`, `ruff format --check`, `mypy` (108 files) clean; `pytest` 597 passed, 6 skipped before the review
  round → 670 passed, 6 skipped. Deterministic eval: cases=200 pass=191 R@1=0.9487 R@5=0.9744 MRR=0.9647 leaks=0
  (unchanged; the excerpt and function-word changes were also compared case by case).
- Frontend: `tsc`, `eslint` clean; `vitest` 346 → 391 (33 files).
- E2E (desktop, mobile, gitlab-mock, gitlab-mock-mobile; `E2E_DISABLED_URL` set): 55 passed, 1 skipped → 65 passed,
  1 skipped.

### 6.10 M5.7 — system facts in the answer (2026-11-24)

Minimal changes to the existing answer view for the AI-native tool loop (`docs/AI_NATIVE_TOOLS.md` «UI»); no new
screen, ribbon, chat framework or debug view; mock mode is unchanged (it does not use tools).

- **«Данные системы SKH»** (`components/SystemFacts.tsx`, `lib/systemFacts.ts`): a block of its own under the answer
  text, apart from «Источники» (whose three groups are unchanged). One row per `system_facts` entry: «По данным реестра
  SKH — {label}», the value with its unit from the observation (`83 документа`, never re-read from the text), the
  filters really applied in words («Фильтр: статус: утверждён · тег: aris»; a text match is «текст содержит «ARIS»»
  and its definition says it is not a tag), «Весь доступный вам каталог, без фильтров» when there are none, items as
  links (`app_path`) with status, «Показаны первые N из M» when `truncated`, quietly the scope, index generation and
  time. A zero says «Нет совпадений в этой области — это ноль, а не ошибка проверки».
- **Markers**: `[F1]` becomes «С1» — outlined (border `--line-field`, surface background), where citation markers are
  filled (1 / К1 / Ф1). A link with a tooltip on hover and focus; Enter or a click moves focus to its row (`tabindex
  -1`, `:focus` wash = the same as a source row reached from its marker). A proposal fact (`drafts_propose`) has no row:
  its marker leads to the existing proposal card (`AskProposal`, anchor `proposal-N`).
- **General knowledge**: `general_knowledge: true` adds a quiet dashed tag «Общие знания, не данные SKH» to the answer
  head (the server's warning stays).
- **Honest states**: tools were used and the answer could not be confirmed → «Не удалось проверить данные системы» with
  each failed check and its own outcome (source unavailable / no answer in time / no access / not found in your scope /
  request refused) and «Уточнить вопрос» — instead of «В базе знаний нет ответа» with lexical near matches. Next to an
  answer that stands, checks that did not work out and that its text does not already report are listed the same way.
- **Conversation**: follow-ups send `history[i].context` = the answer's `conversation_context`; the stream client now
  passes `status.round`, `tool_call` and `tool_result` on; a new model round starts a new preliminary text; one short
  status line names the running check («Проверяю каталог…», «Ищу в документах…», «Смотрю граф связей…», «Смотрю
  шаблоны…», «Готовлю предложение…»).
- Tokens only (no new colour), one primary button per view kept (the cards have none), 1440 / 390 and both themes
  checked on screenshots (`reports/m57/TEST_RESULTS.md`).

### 6.11 «Публикации» — the list of publication jobs (2026-11-24)

Branch `feature/publications-page`. No backend change, no new dependency, existing routes and API unchanged.
- `/publications` (`pages/PublicationsPage.tsx`) lists `GET /api/publications/jobs` — newest first, at most 50 (the
  endpoint has no other filter or paging; at 50 the page says only the newest are shown, so no state chips). Columns:
  document (its title from `GET /api/documents/{id}`, one lookup per document; a document the reader cannot open
  keeps only its ID), state (the existing `PUBLICATION_JOB_STATE_LABEL` and `.pub-state` tones for all nine job
  states), the Confluence page the job reports (`page_id`, `version_after`; a job carries no space), revision,
  «Обновлено». The title opens `/publications/:jobId`, the ID the document; the whole row opens the job. Card rows
  below 720 px, as in the proposals list.
- Empty states come from `GET /api/integrations/status` (`confluence_publisher`): disabled → «Публикация в Confluence
  выключена», the server's message, what publication needs (Confluence REST target, GitLab as the source of merged
  revisions, opt-in) and «Интеграции» → the publisher row; enabled → «Публикаций пока нет» and how a publication
  starts («История» → «Публикация в Confluence» → «Подготовить публикацию», or after a merge); check failed → the
  server's message. Without that status (another permission) the session's `confluence_publish` decides.
- Sidebar: «Публикации» → `/publications`, current on `/publications` and `/publications/:jobId` only; «Интеграции»
  only on `/integrations`. The job page's path starts at «Публикации» → `/publications`. `PUBLICATIONS_HREF` is
  removed; the hash link survives as `PUBLISHER_INTEGRATION_HREF` for the empty state. Checklist and keyboard (§6.2,
  §6.3) are unaffected.
- Checks: `vitest` 391 → 402; E2E 65 passed, 1 skipped → 68 passed, 1 skipped (`publications.spec.ts` desktop and
  mobile, `publication.spec.ts` E2E-37 on gitlab-mock, `/publications` in F-01).

## 7. «Документы» v2 — tree, overview, table (2026-11-24)

Task: the documents v2 handoff (kept in git history), spec `docs/ui-v2/documents/specs/DOCUMENTS_V2.md`, mockups
`docs/ui-v2/documents/screens/design/docs-01…04.png`. Branch
`feature/documents-v2`. The only API change is the spec's §4 (additive: `GET /api/documents/tree`, optional `summary`
and `systems` on list items; the follow-up round changed no contract); no new dependencies — the tree, the menus and the sheets are the app's own components.
Paths without a prefix are under `frontend/src/`.

### 7.1 What was done, by slice

| Slice | What | Commits |
|---|---|---|
| 1. Data | `backend/app/domain/doc_tree.py`: the computed group rule (variant 1: source systems by title and `sys-<key>` tag; integrations by the first consumed source system, else a system tag, else «Общие правила»; standards split into templates and rules; a resolver chain so an explicit `parent` can later go first); `GET /api/documents/tree` through the existing service and visibility (counts, `attention`, per-document review state, owner, systems, link count, group); `summary` / `systems` on list items; `KnowledgeService.today` to pin dates in tests | 1d25fca |
| 2. Views | `Обзор \| Список \| Таблица \| Карта` in the toolbar, the state in the URL (`lib/docsView.ts`: view, node, doc, q — the older `query` read too —, order, the table's keys), the view remembered (`skh.documents.view`), «Список» by default; one shared tree request (`lib/useDocumentTree.ts`) and the tree model (`lib/docTree.ts`) | b3d9233 |
| 3. Tree | `components/docs/DocTree.tsx`: «Фильтр дерева», «Свернуть всё», «Все документы» / «Требуют внимания», sections → groups → documents with the API's counts and the yellow attention counter, status by icon shape; APG Tree View; open branches remembered (`skh.documents.tree`); opens to `doc=` / `node=` from the URL | 91885f5 |
| 4. List and preview | `BranchList.tsx` (path, count, order menu, three-line rows, status only when not approved, no paging, `content-visibility` beyond 200 rows), the toolbar search in the middle column, `DocPreview.tsx` (status, ID, version, title, summary, actions, properties, tags, «Разделы документа»; skeleton, error with retry); the document page's path follows the tree | c45051e |
| Owner's decision | One primary per view: «Открыть» in the preview is secondary, the preview's title is a link to the document; a double click or Enter on a row opens it (slice 4, kept and tested) | fb32e0f |
| 5. Обзор | `lib/docsOverview.ts`, `components/docs/DocsOverview.tsx`: «N документов, M утверждены», «K требуют внимания» (→ the table with «Только требующие внимания»), the matrix sections × Всего / Утверждено (number + share bar) / На ревью / Черновики / Устарели / Нужна проверка / Без владельца with a total row (a real `<table>`: table / row / rowheader / cell), zero a pale «—» with words for assistive technology, a number a chip of its tone → «Таблица» filtered by section and state, a section → «Список» with it open; «Что сделать» by action (Завершить ревью, Назначить владельца, Перепроверить, Черновики и устаревшие), three documents each and «Ещё N» → the filtered table. Counted on the client from the tree | 71476f8 |
| 6. Таблица | `lib/docsTable.ts`, `components/docs/DocsTable.tsx`: menu-button filters (Раздел, Состояние = Статус + «Проверка и владелец», Владелец with «не назначен», Система, Тег, Источник when the base has several), «Только требующие внимания», «N из M», «Группировка: нет / Раздел / Владелец / Система», «Колонки» (remembered, `skh.documents.columns`); columns Название + ID, Раздел, Состояние, Владелец, Системы, Проверен, Связи; header sort with `aria-sort` («Проверен ↑» by default), 38 px rows under a sticky header, the whole row opens the document, ↑↓ between rows, collapsible groups, no paging; every filter, the sort and the grouping in the URL; phones: cards and a filter sheet. `Menu` gained checkbox groups and a trailing count. The old catalog table (`DocsCatalog`, `CatalogTable`, «Вид», «Обновлён», «+ Фильтр») and its CSS are gone | 26919fc |
| 7. Widths, accessibility | «Список»: the preview a right sheet below 1280 px; below 960 px the tree a left sheet behind «Разделы»; phones one screen at a time with «Назад» in the toolbar. «Таблица» below 1280 px: tighter columns, «Системы» hidden until the reader chooses columns. No sideways scroll at 390 / 360 px; dark theme from the tokens; keyboard tests for the overview and the table | 3ca3991 |
| Fixes | «Таблица» never shows a previous search's rows while a new search loads; e2e R2-01 waits for the first header click before the second (a race under the full suite's load) | 1f6dc34, 55da64c |
| 8. This section | — | 3e694b9 |
| Follow-ups (owner's answers, §7.4) | «Система» matches any of a document's systems (tests); «Проверен» keeps «не требуется» last both ways (table and «По дате проверки»); Тег / Источник in «Ещё» with chips; whole-base search verified against `/api/search` (index, ranking, access) and the source on every result row; «Системы» below 1280 px back through «Колонки» and remembered (test); «today» frozen in tests | 3cb0924, aa9df78, 3672e59, 2291e97, 2cf43ba, 6c8b591 |

URL keys of «Таблица» (`lib/docsTable.ts`): `type`, `status`, `flag` (`needs_review`, `no_owner`), `owner`
(`unassigned` = every document without an owner), `system`, `source`, `tag`, `attention=1`, `sort` (`reviewed` by
default, `-key` descending; an old `sort=updated` falls back to the default), `group` (`type`, `owner`, `system`).
Values of one key combine with «или», keys with «и» — so «Перепроверить» is `status=approved&flag=needs_review`.
A link with only table keys opens «Таблица» (old links like `/documents?owner=unassigned` or `?tag=aris` keep working).

Demo numbers (synthetic base, 24 Nov 2026): 83 documents, 73 approved, 12 need attention. Matrix rows (Всего,
Утверждено, На ревью, Черновики, Устарели, Нужна проверка, Без владельца): Продукт 1/1/–/–/–/–/–; Архитектура
1/1/–/–/–/–/–; Домен 9/7/2/–/–/1/–; Системы-источники 12/10/1/1/–/1/1; Интеграции 19/16/–/2/1/1/–; Датасеты
3/3/–/–/–/–/–; Процессы 7/6/–/–/1/1/1; Решения 5/5/–/–/–/–/–; Стандарты 19/17/1/–/1/2/–; Руководства 5/5/–/–/–/–/–;
Глоссарий 2/2/–/–/–/–/–; total 83/73/4/3/3/6/2. «Что сделать»: 4 / 2 / 2 / 6. «Таблица»: «Только требующие внимания»
12 of 83; «Интеграции / Черновики» 2 rows; «Владелец: не назначен» 2; «Система: ARIS» 13.

The assistant uses the same definition: M5.7 `catalog_query` with `filters.needs_attention` applies the tree's rule
(`doc_tree.attention_reasons` via `KnowledgeService.attention_reasons`, the reader's snapshot, today's review state),
so «Сколько документов требуют внимания?» gives the tree's `attention_total` (12 on the demo base) with the rule in
the fact's definition and the reasons per document (`docs/AI_NATIVE_TOOLS.md`).

### 7.2 Keyboard

| Keys | Where | Does |
|---|---|---|
| ↑↓, → / ←, Home / End, Enter, letters | tree (APG Tree View) | move; open or enter / close or go to the parent; first / last; choose; type-ahead. Esc in «Фильтр дерева» clears it |
| ↑↓, Home / End; Space; Enter or double click | branch list (one tab stop) | move between rows; show in the preview; open the document |
| Tab, Enter | preview | the title is a link; «Открыть», «Спросить ассистента», «Предложить изменение» |
| Tab, Enter | «Обзор» | the section (→ «Список»), then its non-zero numbers (→ «Таблица»); zero cells are text, not stops |
| Enter / Space on a header | «Таблица» | sort by the column; again — the other direction (`aria-sort`) |
| ↓ / Enter / Space, ↑↓, Space / Enter, Esc | filter menus, «Ещё», «Колонки» | open; move; toggle (the menu stays open); close and return to the button |
| Tab, Enter / Space | a filter chip («Тег: aris») | its «×» («Убрать фильтр «Тег: aris»») removes the filter |
| ↑↓, Home / End, Enter | «Таблица» rows (one tab stop) | move between rows; open the document |
| Esc | tree and preview sheets, the filter sheet | close and return focus to «Разделы» / the row / «Фильтры» |

### 7.3 Deviations from the mockups and the spec, with reasons

- **One primary button per view (owner's decision).** docs-01 shows two green buttons — «Создать документ» in the
  toolbar and «Открыть» in the preview. By the owner's decision «Открыть» is secondary, the preview's title is a link
  to the document, and a double click or Enter on a list row opens it; the view's one primary is «Создать
  документ» (fb32e0f).
- **Search over the whole base uses `GET /api/documents?query=`**, not `/api/search` (spec §1 «Список ветки»): the
  list shows documents, not passages, and this endpoint gives one row per document with the highlighted snippet and
  «Почему найдено» the catalog already had; 100 per request, «Показать ещё». In «Таблица» the same search narrows
  the rows (up to 500 found documents). Kept by the owner on two conditions, both checked in the code and tested:
  (a) it is the same search as `/api/search` — `KnowledgeService.list_documents` and `SearchService.search` both call
  `RetrievalService.rank_documents` over the same SQLite FTS5 index and the same **reader's snapshot**, which is the
  access check (a document the reader cannot see is found by neither, even through one index of the whole base or a
  declared relation; on the demo base both return the same documents in the same order for one-word queries; the
  list keeps up to 1000 matches, so for several words it may add partial matches beyond `/api/search`'s top-N);
  (b) every result carries its provenance — `source` (`local|gitlab|confluence`), `source_uri`, `revision` were
  already required fields, so no API change — and a result row now says its source quietly («Локальный
  workspace», «GitLab»; «Источник:» for assistive technology), in «Таблица» with a search too. Tests:
  `tests/test_doc_tree.py::test_a_hidden_document_is_found_by_neither_documents_query_nor_search`,
  `::test_documents_query_ranks_like_search_and_every_result_carries_its_source`; contract note in
  `docs/API_CONTRACTS.md` §2. The composer's «@» and the assistant stay on `/api/search` / the retrieval service.
  Finding: the ⌘K palette's instant matches (`components/QuickFind.tsx`) have used `GET /api/documents?query=` since
  phase 4, not `/api/search`; with (a) it is the same index, ranking and access check, so it was left as it is.
- **List rows say a little more than the spec:** «без владельца» on the meta line, the status as shape + text, and
  the source once under the list (on every row when sources mix) — catalog features kept (spec §5).
- **«По названию» uses Russian collation** (Cyrillic before Latin, `localeCompare("ru")`), in the list and in the
  table's «Название».
- **The 12 is date-dependent — in the product, not in the tests.** «Требуют внимания» counts stale reviews (older
  than 180 days) with the server's current date; DEMO-PROC-009 becomes stale on 2026-12-07 and the count then rises
  to 13. The UI keeps counting with the current date (the server's `attention`). The tests are frozen: pytest's
  `client_factory` pins `KnowledgeService.today` to `TEST_TODAY` (2026-11-24) for every app it builds
  (`tests/conftest.py`; a test about the date sets its own); vitest uses the frozen demo tree
  (`__tests__/docsTreeDemo.json`) and one test moves the browser clock to 2027 (fake `Date`) to show the client never
  re-dates reviews; E2E asserts no date-dependent literal — it compares the UI with the API's `attention_total` (the
  stack has no server-date setting, so it is not pinned).
- **«Обзор»:** rows follow the tree's order (spec), not the mockup's order by size; the matrix is a real `<table>`
  (implicit table / row / rowheader / cell roles) instead of a grid of `div`s; «12 требуют внимания» is a link to
  «Таблица» with «Только требующие внимания»; the hint says the numbers open the documents «в таблице» (the mockup
  said «списком»; the spec sends cells to «Таблица»); «Черновики и устаревшие» lists three documents and «Ещё N»
  like the other groups (spec) instead of only «Показать списком»; «Перепроверить» shows the review date, the other
  groups the section; a narrow work area puts «Что сделать» under the matrix, a phone shows the sections as a list
  with chips (no mockup for these widths).
- **«Таблица»:**
  - «Состояние» uses the app's `StatusMark` — a draft is a dashed circle (visual system), not the mockup's filled
    amber dot.
  - «Проверен ↑» puts «не проверялся» first (the oldest of all, as the list's «По дате проверки»); the mockup lists it
    after the dates. «не требуется» (drafts: no review expected) is last in **both** directions (owner's decision):
    «Проверен ↓» is the newest … the oldest, «не проверялся», then «не требуется»; the branch list's «По дате
    проверки» (one direction) follows the same rule.
  - Filters «Тег» (the base's 30 most used tags; a tag is answered by the server, the tree has no tags) and «Источник»
    (only when the base has several sources, or one is chosen) keep the old catalog's facets (spec §5). By the
    owner's decision they sit in one «Ещё» menu after «Только требующие внимания»; the panel keeps Раздел,
    Состояние, Владелец, Система. A value chosen in «Ещё» is a chip on the panel with «×» («Тег: aris», «Источник:
    GitLab»), so an active filter is never hidden; the phone's filter sheet lists every filter as its own group. The
    query is a removable chip; «Сбросить фильтры»; «Спросить ИИ об этих документах» with a query.
  - The old table's «Обновлён» column and «Вид» menu are gone: spec §3 names «Проверен» and header sorting, and the
    tree has no update date.
  - «Состояние» is one menu over two keys (`status`, `flag`), so «Перепроверить» (approved and overdue) is expressible.
  - «Группировка: Система» puts a document under its first system (the one its tree group is named after), so every
    document is counted once; groups collapse like the old table's. The owner confirmed this. A document belongs to
    ONE tree group (its first system), the preview lists ALL its systems («Системы: ARIS, Data Catalog»), and the
    «Система» filter matches a document by ANY of its systems (its menu counts it under each): «Data Catalog» finds
    DEMO-INT-001 and DEMO-INT-004, whose groups are ARIS and CATIA.
  - Below 1280 px «Системы» starts hidden (seven columns do not fit about 850 px without cutting «Название» and the
    status); «Колонки» shows it, and an explicit choice is remembered in this browser (`skh.documents.columns`) and
    holds at any width — accepted by the owner on that condition, pinned by a test that reopens the table at 1100 px.
  - The table is not an ARIA grid: rows are a roving set of title links (↑↓), cells are plain text.
- **One search field.** docs-04 names the table's field «Фильтр таблицы»; the toolbar keeps one field «Найти в
  документах» for «Список» and «Таблица» (the same `q` in the URL).
- **Phones:** «Назад» is an icon button labelled «Назад» (with a tooltip), so «Документы» stays readable at 390 px;
  the branch head puts the order menu under the branch's name.
- **Below 960 px** the tree sheet stays open while a section with groups is opened, and closes on a branch to read or a
  document (one tap fewer than closing it each time).
- **Dark theme** has no mockups; it follows the tokens.

### 7.4 Open questions — the owner's answers (2026-11-24)

1. **«Группировка: Система».** Under the first system, as now: one tree group per document (its first system); the
   preview lists all its systems; the «Система» filter matches any of them. Verified and tested (3cb0924).
2. **«Проверен ↑».** «не проверялся» first in ascending order (older than any date) — kept; «не требуется» always
   last, in both directions; the same for «По дате проверки». Fixed and tested both ways (aa9df78).
3. **«Тег» and «Источник».** Into one «Ещё» menu; an active one is a chip with «×» on the panel (3672e59).
4. **`tags` / `updated_at` in `GET /api/documents/tree`.** Only if, without them, the preview made an extra request
   per document that they would remove. It does not: the preview needs `GET /api/documents/{id}` anyway — for
   «Разделы документа» (`sections`), the version, the summary and the tags (`components/docs/DocPreview.tsx`) — so
   the tree API is unchanged. A tag filter in «Таблица» stays one server request (`GET /api/documents?tag=`).
5. **Whole-base search.** `GET /api/documents?query=` stays, on two conditions — the same FTS5 index and access check
   as `/api/search`, and the source on every result. Both hold (checked in the code, tested); the row now shows the
   source (2291e97). See §7.3.
6. **An explicit `parent`.** Not now. Plan: a separate small task after the branches are merged. `parent` becomes an
   optional front-matter field; when set it beats the computed rule (`GROUP_RESOLVERS` in
   `backend/app/domain/doc_tree.py` takes a resolver in front — the code is ready, see
   `test_an_earlier_resolver_wins_so_an_explicit_parent_can_be_added_in_front`), otherwise the rule applies. It is
   introduced through the template registry as a new template version, so existing documents and drafts keep and are
   validated against their version and nothing is migrated. Trigger: the first document the rule places wrongly.
7. **«Системы» below 1280 px.** Hidden by default is fine as long as «Колонки» brings it back and the choice is
   remembered — it is (test, 2cf43ba).
8. **«Today» in tests** (raised with the answers). Frozen in pytest, vitest and E2E as above; product code keeps the
   current date (6c8b591).

### 7.5 Checks

- Frontend: `tsc`, `eslint` clean; `vitest` 391 before «Документы» v2 → 427 after slice 4 → 453 after slice 7 and
  the fix (38 files; new: `docsOverview.test.tsx`, `docsTable.test.tsx`; updated: `explorer.test.tsx`,
  `docsList.test.tsx`, `documentsView.test.tsx`).
- Backend (changed in slice 1 only): `pytest` 670 passed, 6 skipped → 696 passed, 6 skipped; `make lint` (ruff,
  ruff format, mypy; tsc, eslint) clean.
- E2E (desktop, mobile, gitlab-mock, gitlab-mock-mobile; `E2E_DISABLED_URL` set): 65 passed, 1 skipped before
  «Документы» v2 → 69 passed, 1 skipped after slice 4 → 73 passed, 1 skipped (new: `documents.spec.ts` V2-05 to
  V2-08; `catalog.spec.ts` R2-01 and `scenarios.spec.ts` E2E-02 rewritten for the new table). One full run before
  55da64c had R2-01 fail once (the double header click race); after the fix three runs of the affected specs and a
  full run passed.
- Screenshots of «Обзор», «Список», «Таблица» × 1440 × 900, 1100 × 800, 390 × 844 × light / dark, the 900 px tree
  and preview sheets, and an overflow check at 360 px — outside the repository.
- Follow-up round (§7.4): `vitest` 453 → 463 (38 files; `docsTable.test.tsx`, `docTree.test.tsx`,
  `docsOverview.test.tsx`, `explorer.test.tsx`); `pytest` 696 passed, 6 skipped → 699 passed, 6 skipped
  (`tests/test_doc_tree.py`: the hidden document by neither search path, the same ranking with the source on every
  result, the pinned «today»; `tests/conftest.py` pins it for every app); `make check` clean (ruff, ruff format,
  mypy, tsc, eslint, pytest, vitest). E2E (all four projects, `E2E_DISABLED_URL` set): 73 passed, 1 skipped, as
  before — `documents.spec.ts` no longer asserts a date-dependent literal. Screenshots of «Ещё» with a chip, both
  «Проверен» directions, the preview's systems, «Система: Data Catalog», search results with their source and the
  1100 px «Колонки» choice — outside the repository.

## Пустой документ и «Применить шаблон» (2026-11-24)

The owner's request: create a document without choosing a template, as in Obsidian or Notion; SKH forms the
technical metadata; free Markdown, WikiLinks and the AI assistant are available; a template can be applied to an
existing document later. Templates help structure documentation, they do not gate its creation. API:
`docs/API_CONTRACTS.md` («Blank documents and «Применить шаблон»»); rules: `docs/TEMPLATE_HUB.md`,
`docs/METADATA_AND_LINKS.md`.

- **«Создать документ»** (`/documents/new`): «Пустой документ» comes first — «Название», «Раздел каталога» (the
  types of `GET /api/document-types`, «Руководства» by default, a hint says why a section is needed) and «Начать
  писать» opens the editor. «По шаблону» below is today's flow, unchanged (also `?template=` from the Template Hub).
  With no active template the page still creates blank documents.
- **Editor of a blank draft**: the body starts as `# Название` only; «Раздел каталога» is a select; «Происхождение»
  says «без шаблона»; the new «Шаблон» row says «не применён» (or the pinned template and version) next to
  «Применить шаблон». `[[` autocomplete, diagnostics, preview, save / check / submit are the same as for template
  drafts. The AI panel offers metadata, related documents, improve, summarize and explain; «Проверить полноту»
  appears once a template is applied; with `AI_PROVIDER=disabled` there is no AI panel. Drafts without a template —
  blank ones and imported files — now open in this editor (the M5.6.3 limitation is gone; the import page always
  continues in the editor).
- **«Применить шаблон»** (the editor's «Шаблон» row; the document page's «Ещё» menu): a modal sheet (a bottom
  sheet on phones) — a select of the active templates with the chosen one's section and required sections, then
  «Что изменится» (pinned template + version, section before → after, the ID stays), the sections as matched ✓ /
  added + / kept • / optional not added ○, the validation of the result and the diff. Confirm updates the draft
  (and reopens it with a success notice) or, on a document page, creates a change proposal and opens it — the
  document itself is never modified. A stale preview disables the confirm and offers «Обновить предпросмотр».

Deviations and open points:
- The template chooser in the sheet is a select, not radio cards: with 12 templates the cards pushed the preview
  below the fold. The create page keeps its cards.
- «Применить шаблон» in the editor works on the saved draft (as the AI proposals): with unsaved edits the button is
  disabled with the reason. «Причина / цель документа» stays required for the first save of a blank draft (same
  rule as template drafts), so a blank document is stored when the author saves it, not when «Начать писать» opens
  the editor.
- Blank IDs are `SEM-DOC-NNN` and stay after a template is applied (IDs never change), so an architecture document
  created blank keeps `SEM-DOC-…` rather than `SEM-ARCH-…`. The default section is `guide` («Руководства»).
- The API also applies a template to an `update` draft; the change-proposal editor (`/proposals/new?edit=`) has no
  button for it yet. The import page has no explicit «Без шаблона» choice: the server accepts an import without
  `template_id` (a blank document) and uses it automatically when no template is active.

Checks (this branch, real runs): backend `ruff`, `ruff format --check`, `mypy` clean; `pytest` 670 → 689 passed,
6 skipped; deterministic eval unchanged (cases=200 pass=191 R@1=0.9487 R@5=0.9744 MRR=0.9647 leaks=0). Frontend
`tsc`, `eslint` clean; `vitest` 391 → 400 (34 files). E2E desktop + mobile (`E2E_DISABLED_URL` set): 61 passed,
1 skipped (the Confluence scenario needs a connector), 6 of them new (`e2e/blankDocument.spec.ts`).

## Ответ ассистента в Markdown (2026-11-24)

Root cause of the literal `**…**`, backticks and list dashes in answers: `AnswerText` split the raw model text on blank
lines and newlines and `MarkedLine` put the markers in with a regex — there was no Markdown parser (reproduced by
`frontend/src/__tests__/answerMarkdown.test.tsx` against the previous code). The model's final answer is Markdown
(`docs/AI_NATIVE_TOOLS.md` «Provider protocol»), so the UI now renders it as such.

- **One pipeline** (`lib/answerMarkdown.ts`, `components/AnswerMarkdown.tsx`): `react-markdown` 10.1.0 + `remark-gfm`
  4.0.1 (MIT, React ≥ 18, pinned exactly; `unified` / `remark-parse` declared for the copy path, no extra bundle).
  Bold, italic, strikethrough (`~~x~~` only — «~100 документов» is not struck through), inline and fenced code,
  headings, ordered / unordered / task lists, block quotes, links, GFM tables; the model's single line breaks stay line
  breaks. Used for the final answer, the mock remainder lines and the preliminary text.
- **Markers are AST nodes.** A remark plugin finds `[n]` and `[Fn]` in mdast TEXT nodes only — never in inline / fenced
  code, link text, URLs or titles — and only for references the server verified (`citations[].ref`,
  `system_facts[].ref`); anything else (`[7]`, `[F9]`, a raw `[C1]`) stays literal. `CitationMarker` and `FactMarker`
  are unchanged (labels 1 / К1 / Ф1 / С1, cards on hover and focus, navigation). Grouped forms like `[1, 2]` are not
  produced by the server and are not interpreted (they read as intervals in prose). The element components are
  module-level, so a re-render never remounts a marker (its card and focus survive); labels and facts are memoised per
  answer, so streaming another turn does not re-parse earlier answers.
- **Untrusted text.** Raw HTML is shown as text (`<script>` is visible, never run; no `skipHtml`, no rehype-raw, no
  `dangerouslySetInnerHTML`). Links keep only `http(s):`, `mailto:` and app paths (`/…`, never `//host`); app paths
  navigate inside the app, external links open in a new tab with `rel="noopener noreferrer"`; any other link is its
  text only. Images are never loaded (their alt text stands in: `[изображение: …]`). Link reference definitions are
  switched off, so a model-written `[1]: https://…` cannot turn the marker `[1]` into its link; GFM footnotes stay text
  (they would add page-wide ids).
- **Streaming.** Preliminary text gets the same formatting with nothing interactive: no markers (`[C1]` stays text) and
  links as plain text; the validated answer replaces it.
- **«Копировать с источниками»** copies readable text built from the same tree — no Markdown syntax, `- ` / `1. ` items,
  table rows `a | b`, code as written, markers relabelled `[1]` / `[К1]` / `[С1]` (code is not relabelled).
- **Layout** (tokens only): prose keeps the 68ch measure, a table or code block may use the answer's full width and
  scrolls sideways in its own frame (a named tab stop when it overflows); compact sizes in the document panel; Markdown
  headings go below the answer's heading (`#` → h3 in the dialog, h4 in the panel). A marker inside a table frame is
  not a containing block, so its card is not clipped by the frame.

Bundle: JS 867.37 → 1 041.22 kB minified (gzip 259.59 → 313.24 kB, +53.65 kB); CSS 176.20 → 178.45 kB. Measured
alone, `react-markdown` + `remark-gfm` are 166 kB minified / 50.6 kB gzip, of which the micromark parser with GFM is
23.8 kB gzip. If the size matters later: a lazy chunk for the answer renderer, or rendering mdast directly without the
hast layer.

Checks: `vitest` 504 → 519 (15 new in `answerMarkdown.test.tsx`; no existing test changed); pytest
`tests/test_answer_markdown_scripted.py` (the server keeps the Markdown and the verified markers, openai and claude
transports); Playwright `e2e/answerMarkdown.spec.ts` on the scripted projects (desktop and phone; scripted-model
scenario «оформи»).

### Происхождение источников и режим ИИ (2026-11-24)

The server no longer appends «Используются только демо-документы…» to every answer; it sends the origin of the
validated evidence as metadata (`docs/API_CONTRACTS.md` «Answer provenance»). The UI shows it quietly and once
(`lib/provenance.ts`, `components/Provenance.tsx`):

- **One line per answer**, in the answer's head (dialog and document panel), `--text-secondary`, caption size — not a
  notice: «Источники: синтетические (учебные)» (with the amber dot of «Демо-данные»), «Источники: не помечены как
  синтетические», «Источники: смешанные — 2 синтетических, 1 без пометки, 1 без указания происхождения»,
  «Происхождение источников не указано». Nothing for `overall: none` (insufficient evidence, general knowledge, a bare
  registry number) and nothing from an older server without the field.
- **Per source only when the sources differ** (`overall: mixed`): a quiet mark in the source's meta row under
  «Источники», in the citation card and on documents listed by a system fact — «синтетический», «не помечен как
  синтетический», «происхождение не указано» (screen readers hear «Происхождение: …»). When all sources share one
  origin, the line covers them; `unknown` (attachments only) is also one line, not a mark per file. The former «демо»
  per source row and card is gone. Never «реальный»: «без пометки» is the absence of a mark, and an attachment's
  `is_demo: false` says nothing. The server's `MIXED_PROVENANCE_WARNING` and every other material warning stay
  notices as before.
- **Catalog facets**: `breakdown.provenance` is «По происхождению — синтетические 83 · без пометки 2 · не указано 1».
- **Copy**: «Копировать с источниками» ends with «Происхождение источников: …» and, when mixed, each source line
  with its origin — copied text leaves the app, where the line is not visible.

**Mode is not content.** `AI_PROVIDER=mock` is a mode — no language model, verbatim excerpts — and is named so: the chip
«ИИ: без модели» (popover «Без языковой модели (mock)»), the answer's mode «Без языковой модели: дословные выдержки»
(«…: предложение по правилам» for a rule-based proposal), the panel's and a proposal card's tag «Без модели»
(`.mode-tag`: dashed outline like the chip, never amber), the AI provider's state «Без модели (mock)» on
«Интеграции» (a mock connector of Confluence keeps «Демо (mock)»: its pages are synthetic). The server's own texts say
the same («Без языковой модели: ниже приведены дословные выдержки…»; the UI drops that first line from the extractive
text — also an older «Демо-режим:»). Amber (`--demo-*`) is reserved for synthetic content: the toolbar's «Демо-данные»
badge, unchanged, and the provenance dot.

Checks: `vitest` 519 → 542 (`answerProvenance.test.tsx` 19 new; a facets, a mode-vs-corpus, a `StateBadge` and a
mode-line filter test; tests that pinned «ИИ: демо», «Демо-режим: …» or «Демо (mock)» updated with the labels);
Playwright `e2e/answerProvenance.spec.ts` on the scripted projects («Какая у нас модель данных?» → «нам интересны
демо-файлы», «Это реальные данные банка?», phone); E2E-04 and the document panel check the line and the absence of a
warning notice on the mock stack.
