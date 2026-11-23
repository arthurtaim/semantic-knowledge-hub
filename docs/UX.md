# Web UI / UX acceptance contract

## Screens
1. **Knowledge Home:** product title, quick search, visible categories (Product, Architecture, Domain, Integrations, Processes, Decisions), recent verified documents and integration-state indicators.
2. **Knowledge Explorer:** left navigation tree or categories, document list and filters (status, owner, type, tag, source); search snippets and clear empty state.
3. **Document Detail:** rendered Markdown, YAML metadata as human-friendly badges, related links, source URI, author/owner, status, review date, raw/revision view when available. Sanitize HTML/Markdown against XSS.
4. **Ask Knowledge Base:** question input, scope selector (Team / Corporate / Both), answer with numbered clickable citations and a transparent mock/AI state. UI must say no corporate source is connected when disabled.
5. **Proposal/Diff:** prompt or manual text draft, side-by-side or unified diff, validation results, reject / mark ready for review. "Mark ready" is **not** "merge" or "approve source". No automatic production write.
6. **Integration Status:** GitLab connected/not connected, Confluence MCP connected/not connected, AI model mock/connected, publication off/on, task system unavailable.

## Design expectations
- Modern enterprise UI, restrained palette, responsive desktop and mobile (desktop priority), keyboard-accessible interactions.
- Russian user-facing text, technical terms preserved where useful.
- Avoid decorative AI claims and invented corporate data. Show conspicuous `Демо-данные` on fixtures.
- Meaningful loading, error, permission-denied, no-results and disabled-integration states.
- Citation clicks open an allowed document in the app or its authorized source URL. Never generate source links from arbitrary user input.

## Demo walk-through
1. Launch at `localhost`; see synthetic docs and demo warning.
2. Search `ARIS`; result shows an obviously synthetic integration document.
3. Open result; see `draft`, owner and source details.
4. Ask what ARIS sends; assistant states what the synthetic source confirms and what is unknown (must **not** assert unverified actual ARIS flows).
5. Propose improved wording; preview diff, reject and verify the approved/local source is unchanged.
6. Inspect integrations page: local connected; GitLab/Confluence unavailable; AI mock.
