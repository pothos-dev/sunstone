# 05 — Web quick-nav command palette (hydrated island)

**What to build:** Add a quick-nav command palette to the SSR web build — the feature was previously desktop-only. Pressing Ctrl/Cmd+K (and clicking the rail's quick-nav icon) opens a fuzzy palette over the bundle's concept paths and tags, served by the existing read-only API. Selecting a result navigates via SvelteKit client-side routing. The palette is an interactive client island that hydrates on the client; the main content stays server-rendered.

**Blocked by:** 04 (the web rail exists and gains the quick-nav button here).

**Status:** ready-for-agent

- [ ] Ctrl/Cmd+K opens a quick-nav palette on web; the rail's quick-nav icon opens the same palette.
- [ ] The palette fuzzy-matches over concept paths and tags using the existing read-only API (`/api/concept-paths`, `/api/tags`, `/api/concepts-by-tag`).
- [ ] Selecting a result navigates to that concept via SvelteKit routing (no full reload).
- [ ] The palette hydrates client-side only and does not break SSR of the main content.
- [ ] Reuses shared pure helpers where practical (fuzzy highlight, list navigation) as the web search modal does.
- [ ] `bun run check` green; web build builds; a Playwright/web spec covers opening the palette and navigating.

## Comments

- "Recent files" is unavailable on web (no bundle session state on the read-only backend) — scope the palette to paths + tags.
