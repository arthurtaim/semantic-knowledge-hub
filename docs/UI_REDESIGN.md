# UI redesign — ledger green

Task specification for Claude Code (and GigaCode later) to make the interface simpler, more consistent and
less templated, with a green visual identity. Functionality, Russian copy, accessible names and test
contracts stay unchanged. Phases 1–3 are implemented; the dark colour scheme is deferred (see §3).

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
| `--accent-ink` | `#12402a` | hover, selected segmented / chip / toggle |
| `--accent-wash` | `#e2eee5` | hover wash, current step |
| `--accent-bright` | `#9fd3b0` | active nav underline and focus on the dark bar |
| `--paper` | `#f1f4ef` | page background (cool sage, not cream) |
| `--ink` | `#17231c` | text, section rules |
| `--line` / `--line-strong` | `#d6ddd4` / `#adbaaf` | rules and inputs |

Statuses keep their own hues: approved `#23683f` (deliberately the brand green), in review `#345595`,
draft `#8a5a00` (dashed), deprecated `#737a74` (struck through), danger `#a3332b`. State is always carried by
text and shape too, never by colour alone.

**Type.** Golos Text (Paratype, built for Cyrillic UI) for interface; PT Serif for document prose; JetBrains
Mono only for IDs, revisions and diffs. Scale unchanged (`--step--1 … --step-4`). Headings get −0.02em tracking.

**Shape.** One radius (`--radius: 3px`) for buttons, inputs, chips and tags. No gradients, no drop shadows.

### Rules for new UI

1. Group with rules and whitespace, not boxes. A bordered surface is reserved for things that are
   *objects*: the Markdown document, the passport, the diff, forms, integration cards.
2. One primary (filled green) button per view. Secondary actions are outlined; tertiary are underlined
   text buttons (`.button--quiet`).
3. List titles are ink-coloured and underline on hover; inline links in prose stay green and underlined.
4. Selected / pressed state = `--accent-ink` fill. Focus = 3 px `--accent` outline (`--accent-bright` on the bar).
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

## 5. Phase 4 — AI-first entry (from `docs/research/SKH_UI_UX_direction_2026.md`)

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

- [ ] Q1 Contrast: `--deprecated: #5f665f`; `--line-input: #7d8a80` for inputs, selects, textareas, segmented,
  filter chips and toggles (decorative rules keep `--line-strong`); faux-bold 700 → 600.
- [ ] Q2 `scroll-padding-top` = bar height + 16 px; H1 on 404 and page-level errors; APG arrow/Home/End keys on
  tabs; Esc closes the mobile menu and returns focus to «Меню».
- [ ] Q3 AI-mode chip and striped «Демо» pill in the top bar (with a popover of facts); remove the full-width
  band and the explorer's bottom notice; keep the passport fact and the text «Демо-данные.» (role `note`).
- [ ] Q4 Selected = accent-wash + accent-ink border (never a solid fill); «Утверждён» = seal glyph + ink text,
  no green fill; `info` gets its own neutral-blue-free tone, «На ревью» keeps the review hue.
- [ ] Q5 One date formatter: relative for recent dates, full date in the tooltip, `nowrap` in tables.
- [ ] Q6 Propose-change: body editor without YAML; metadata shown as fields; source with YAML behind a toggle.

AI-first entry:

- [ ] E1 «Спросить или найти» composer in the top bar: ⌘K / Ctrl+K and `/`, visible trigger, accessible
  combobox with instant matches from `GET /api/documents?query=`; Enter on a question asks the AI and opens the
  answer; Tab switches «Спросить ИИ» / «Найти»; disabled → search only, placeholder «Найти в базе знаний…».
- [ ] E2 Home hero = the same composer with the scope switch «Команда / Корпоративные / Оба» (default «Команда»)
  and the user's recent questions below; «Спросить ассистента» removed (tests updated in the same commit).
- [ ] E3 Evidence-first answer: quotes and [n] markers before the explanation; marker hover card (passage,
  document, source badge, revision, status); click opens the document at `section_anchor`; categorical support
  level «Подтверждено источниками / Частично подтверждено / Недостаточно данных»; next actions «Открыть
  документ», «Предложить правку по этому ответу», «Уточнить вопрос»; stages «Ищу источники → Формулирую ответ →
  Проверяю цитаты»; team and corporate sources in separate lists.
- [ ] E4 «Недостаточно данных» card («В базе знаний нет ответа на этот вопрос»): what and where was searched,
  closest partial matches with citations, three steps (refine; a separate labelled corporate search; «Создать
  черновик документа»). Four AI modes per the research table; no dead controls; demo answers labelled «Демо».

Deferred (not in phase 4): tokens v2 / OKLCH, dark and high-contrast themes, headless library and icons,
sidebar shell v2, CollectionView, Peek, ⌘J context panel on every object, tasks / board / Gantt, AI delegates,
backend span-level citation verification, server-side saved answers. Open owner decisions: the accent green
(stays `--accent: #1d5c3c`; the research suggests `#18693f` or `#1f7a4d`), corporate sources only as a
separate labelled step.
