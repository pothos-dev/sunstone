<script lang="ts">
  // Left activity rail (slice: left-activity-rail). A thin, always-visible
  // vertical strip on the far-left edge of the desktop shell, holding the
  // application-GLOBAL controls that don't belong to any open Concept or Tile:
  // a menu button (a stub for now), quick-nav, and search. It sits OUTSIDE the
  // collapsible left Sidebar, so it stays visible when the Sidebar is collapsed.
  //
  // Presentational only: it owns no business state. The quick-nav / search
  // buttons call back into App, which flips the SAME overlay-open flags the
  // Ctrl+K / Ctrl+Shift+F keybindings flip — so both entry points converge on
  // one code path.
  //
  // The bottom-pinned avatar/login slot is reserved but EMPTY on desktop; the
  // web anon read surface fills it (via the optional `user` snippet) with the
  // real Auth.js sign-in / sign-out affordance.

  import type { Snippet } from 'svelte';

  interface Props {
    /** Open the app menu. A no-op stub today (no menu contents yet). */
    onMenu: () => void;
    /** Toggle the quick-nav palette (same flag as the Ctrl+K keybinding). */
    onQuickNav: () => void;
    /** Toggle the full-text search panel (same flag as Ctrl+Shift+F). */
    onSearch: () => void;
    /** Optional bottom user slot. Desktop passes none (the slot stays empty);
     *  the web viewer fills it with a sign-in / sign-out affordance. */
    user?: Snippet;
  }

  let { onMenu, onQuickNav, onSearch, user }: Props = $props();
</script>

<nav class="activity-rail" aria-label="Activity rail" data-testid="activity-rail">
  <div class="rail-top">
    <button
      type="button"
      class="rail-btn"
      data-testid="rail-menu"
      title="Menu"
      aria-label="Menu"
      onclick={onMenu}
    >
      <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
        <line x1="2.5" y1="4" x2="13.5" y2="4" stroke="currentColor" stroke-width="1.4" />
        <line x1="2.5" y1="8" x2="13.5" y2="8" stroke="currentColor" stroke-width="1.4" />
        <line x1="2.5" y1="12" x2="13.5" y2="12" stroke="currentColor" stroke-width="1.4" />
      </svg>
    </button>
    <button
      type="button"
      class="rail-btn"
      data-testid="rail-quicknav"
      title="Quick nav (Ctrl+K)"
      aria-label="Quick nav"
      onclick={onQuickNav}
    >
      <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
        <!-- compass glyph: quick navigation. -->
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3" />
        <polygon points="8,4 9.6,9.6 4.4,8" fill="currentColor" opacity="0.85" />
      </svg>
    </button>
    <button
      type="button"
      class="rail-btn"
      data-testid="rail-search"
      title="Search (Ctrl+Shift+F)"
      aria-label="Search"
      onclick={onSearch}
    >
      <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
        <!-- magnifying glass glyph. -->
        <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.3" />
        <line x1="10.2" y1="10.2" x2="13.5" y2="13.5" stroke="currentColor" stroke-width="1.4" />
      </svg>
    </button>
  </div>

  <!-- Bottom-pinned avatar/login slot: reserved + EMPTY on desktop (no `user`
       snippet), filled by the web viewer with a sign-in / sign-out affordance. -->
  <div class="rail-user" data-testid="rail-user" aria-hidden={!user}>
    {#if user}{@render user()}{/if}
  </div>
</nav>

<style>
  .activity-rail {
    width: 48px;
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 0;
    border-right: 1px solid var(--border);
    background: var(--bg-elevated);
  }

  .rail-top {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
  }

  .rail-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-muted);
    font: inherit;
    line-height: 1;
    cursor: pointer;
    opacity: 0.85;
    transition: background 0.12s ease, opacity 0.12s ease;
  }

  .rail-btn:hover {
    background: var(--hover);
    opacity: 1;
  }

  .rail-btn:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: -2px;
    opacity: 1;
  }

  /* Reserved bottom slot: kept in the layout (so the rail always reserves the
     space) but paints nothing on desktop. */
  .rail-user {
    flex: none;
    width: 2rem;
    height: 2rem;
  }
</style>
