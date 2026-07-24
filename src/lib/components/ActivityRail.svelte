<script lang="ts">
  // Left activity rail (slice: left-activity-rail). A thin, always-visible
  // vertical strip on the far-left edge of the desktop shell, holding the
  // application-GLOBAL controls that don't belong to any open Concept or Tile:
  // quick-nav and search. It sits OUTSIDE the collapsible left Sidebar, so it
  // stays visible when the Sidebar is collapsed.
  //
  // Presentational only: it owns no business state. The quick-nav / search
  // buttons call back into App, which flips the SAME overlay-open flags the
  // Ctrl+K / Ctrl+Shift+F keybindings flip — so both entry points converge on
  // one code path.
  //
  // The bottom-pinned area holds an optional `bottom` slot (web fills it with
  // the theme toggle) sitting just above the avatar/login slot. That user slot
  // is reserved but EMPTY on desktop; the web anon read surface fills it (via
  // the optional `user` snippet) with the real Auth.js sign-in / sign-out.

  import type { Snippet } from 'svelte';

  interface Props {
    /** Toggle the quick-nav palette (same flag as the Ctrl+K keybinding). */
    onQuickNav: () => void;
    /** Toggle the full-text search panel (same flag as Ctrl+Shift+F). */
    onSearch: () => void;
    /** Optional bottom-pinned controls, rendered just above the user slot.
     *  Desktop passes none; the web viewer fills it with the theme toggle. */
    bottom?: Snippet;
    /** Optional bottom user slot. Desktop passes none (the slot stays empty);
     *  the web viewer fills it with a sign-in / sign-out affordance. */
    user?: Snippet;
  }

  let { onQuickNav, onSearch, bottom, user }: Props = $props();
</script>

<nav class="activity-rail" aria-label="Activity rail" data-testid="activity-rail">
  <div class="rail-top">
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

  <!-- Bottom-pinned controls. `bottom` (web: theme toggle) sits just above the
       avatar/login slot, which is reserved + EMPTY on desktop (no `user`
       snippet) and filled by the web viewer with a sign-in / sign-out. -->
  <div class="rail-bottom">
    {#if bottom}{@render bottom()}{/if}
    <div class="rail-user" data-testid="rail-user" aria-hidden={!user}>
      {#if user}{@render user()}{/if}
    </div>
  </div>
</nav>

<style>
  .activity-rail {
    box-sizing: border-box;
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

  .rail-top,
  .rail-bottom {
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
