# UI redesign — ledger green

Task specification for Claude Code (and GigaCode later) to make the interface simpler, more consistent and
less templated, with a green visual identity. Functionality, Russian copy, accessible names and test
contracts stay unchanged. Phase 1 is implemented; phases 2–3 are the next steps.

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

### Phase 2 — page-level simplification (next)

- [x] Document page: merge the in-page demo notice into the passport as a "Демо-документ" field, so the
  only demo notice above the fold is the bar (keep text matched by `document.test.tsx`). The field is the
  first passport row (label above the text) and keeps the original copy, including "Демо-данные.".
- [x] Explorer: collapse the meta row to `ID · Раздел · Владелец · Обновлён`; show "Источник" only when
  sources are mixed; move "Проверка" next to the stamp. With one source it is named once above the list
  ("Источник: …") and stays in each row as visually hidden text, so every result still carries its
  provenance for screen readers. The review flag is text plus a hollow ring. Pressed filter = `--accent-ink`.
- [x] Explorer on phones: filters into a `<details>` "Фильтры (n)" disclosure above results (below 860 px,
  `useMediaQuery`); closed by default, opened when a filter is active.
- [ ] Integrations: two-column list (name + state | facts) instead of a three-column card grid; group
  "Не подключено" items under one heading.
- [ ] Proposal detail: put actions (mark ready / reject / submit) in a sticky right rail on ≥ 1100 px.

### Phase 3 — polish

- [ ] Ask page: answer column 68ch with citations in a right rail on wide screens.
- [ ] Authoring editor: align toolbar, save-state and pane labels to the ruled style.
- [ ] Dark-bar print stylesheet check; `prefers-color-scheme: dark` token set.

## 4. Acceptance

- `npx tsc --noEmit`, `npx eslint .`, `npx vitest run` pass (102 tests at phase 1).
- `npx playwright test` desktop, mobile and gitlab-mock projects pass (27 tests at phase 1).
- No horizontal scroll at 360 px; keyboard focus visible on the dark bar and on paper.
- No changes to API calls, routes, accessible names or Russian copy that tests rely on.
