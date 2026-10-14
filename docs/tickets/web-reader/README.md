# Web reader

Bring the anonymous Sunstone Web reader (`src/lib/web/WebReader.svelte`, the
SSR read-only surface a signed-out visitor gets) up to the desktop's Concept
surfaces, so a reader and a signed-in user see the same thing.

Decisions that bind the tickets here:

- **Reuse the desktop component, don't twin it.** Where the desktop has a
  props-only component (`TileHeader`, `LifecycleBadge`, …), the reader renders
  that component; it does not grow its own look-alike.
- **SSR first paint stays complete.** Whatever the reader shows must render on
  the server, without CodeMirror or desktop stores (`focus`, `session`).
- **Narrow screens keep working.** The ≤ 768px drawer and overflow-menu
  behaviour (`mobileLayout.ts`) is preserved.

Out of scope: editing in the reader (signed-in users already get the full App
shell), and changes to the reader's sidebars.
