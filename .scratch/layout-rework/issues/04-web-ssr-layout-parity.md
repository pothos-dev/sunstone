# 04 — Web SSR layout parity: rail + edge sidebars + web concept strip

**What to build:** Bring the same layout to the SSR web build. Replace the WebViewer toolbar with the left activity rail (menu stub, search wired to the existing web search modal, avatar/login slot) and give both web sidebars the same click-to-collapse / drag-to-resize borders as desktop. Back/forward, export-PDF, and the theme toggle move onto a slim web concept strip (the web analogue of the concept header). No Edit button appears — the web build is still read-only. Everything is server-rendered on first paint and the interactive chrome hydrates on the client.

**Blocked by:** 02, 03 (reuses the rail and edge-sidebar components built for desktop).

**Status:** ready-for-agent

- [ ] The web left rail matches the desktop rail's structure: menu (stub) + search (opens the existing `WebSearch` modal) + bottom avatar/login slot. Quick-nav is added in 05.
- [ ] Both web sidebars collapse/expand on border click and resize on drag; widths persist in localStorage (the web backend is read-only and cannot persist bundle state server-side).
- [ ] Back/forward, export-PDF, and theme toggle live on a slim web concept strip; the old toolbar is removed.
- [ ] Main content (rendered concept, tree, properties, outline) remains server-rendered; the rail, edges, search, and theme controls hydrate as client islands. No hydration mismatch.
- [ ] Existing web features unaffected: SSE live reload, mermaid client rendering, backlinks/tags fetch.
- [ ] `bun run check` green; the web build (`SUNSTONE_TARGET=web`) builds; relevant Playwright/web specs updated.

## Comments

- Search already exists on web (`WebSearch`, Ctrl+Shift+F) — this ticket only relocates its launcher into the rail.
- Web has no tiles/CodeMirror; the "concept strip" is a light header, not the full desktop concept header.
- No Edit button on web until the web-write epic lands (see 06).
