<script lang="ts">
  // Activity rail (slice: left-activity-rail, extended by rail-sidebar-toggles).
  // A thin, always-visible vertical strip on the far-left OR far-right edge of
  // the shell, holding the controls that don't belong to any open Concept or
  // Tile. It sits OUTSIDE the collapsible Sidebars, so it stays visible when the
  // adjacent Sidebar is collapsed — which is what makes a 0-width collapse
  // possible at all: the rail's toggle button is the only affordance needed to
  // bring the Sidebar back, so the Sidebar's border no longer has to survive as
  // a click target.
  //
  // The FIRST button on every rail is that toggle. Its icon switches on the
  // adjacent Sidebar's state (filled panel = shown, empty panel = hidden) and
  // it mirrors per `side`, so the filled edge always points at the Sidebar the
  // button controls.
  //
  // Presentational only: it owns no business state. The toggle / quick-nav /
  // search buttons call back into the parent, which flips the SAME flags the
  // keybindings flip — so both entry points converge on one code path.
  //
  // The bottom-pinned area holds an optional `bottom` slot (web fills it with
  // the theme toggle) sitting just above the avatar/login slot. That user slot
  // is reserved but EMPTY on desktop; the web anon read surface fills it (via
  // the optional `user` snippet) with the real Auth.js sign-in / sign-out.

  import type { Snippet } from 'svelte';
  import type { SidebarSide } from '$lib/sidebarResize';

  interface Props {
    /** Which edge of the shell this rail is docked to. */
    side: SidebarSide;
    /** Whether the adjacent Sidebar is expanded (drives the toggle icon + label). */
    sidebarOpen: boolean;
    /** Accessible noun for the adjacent Sidebar, e.g. "sidebar" / "Outline & Backlinks". */
    sidebarLabel: string;
    /** Stable test id for the toggle button. */
    toggleTestid: string;
    /** Collapse / expand the adjacent Sidebar. */
    onToggleSidebar: () => void;
    /** Toggle the quick-nav palette (same flag as the Ctrl+K keybinding). */
    onQuickNav?: () => void;
    /** Toggle the full-text search panel (same flag as Ctrl+Shift+F). */
    onSearch?: () => void;
    /** Optional bottom-pinned controls, rendered just above the user slot.
     *  Desktop passes none; the web viewer fills it with the theme toggle. */
    bottom?: Snippet;
    /** Optional bottom user slot. Desktop passes none (the slot stays empty);
     *  the web viewer fills it with a sign-in / sign-out affordance. */
    user?: Snippet;
  }

  let {
    side,
    sidebarOpen,
    sidebarLabel,
    toggleTestid,
    onToggleSidebar,
    onQuickNav,
    onSearch,
    bottom,
    user,
  }: Props = $props();

  // Panel-glyph geometry, mirrored per side so the filled sliver always sits on
  // the rail's own edge (i.e. where the Sidebar it controls actually is).
  const dividerX = $derived(side === 'left' ? 6.5 : 9.5);
  const fillX = $derived(side === 'left' ? 2 : 9.5);
  const fillW = 4.5;
</script>

<nav
  class="activity-rail {side}"
  aria-label={side === 'left' ? 'Activity rail' : 'Activity rail (right)'}
  data-testid={side === 'left' ? 'activity-rail' : 'activity-rail-right'}
>
  <div class="rail-top">
    <button
      type="button"
      class="rail-btn"
      data-testid={toggleTestid}
      title={sidebarOpen ? `Collapse ${sidebarLabel}` : `Expand ${sidebarLabel}`}
      aria-label={sidebarOpen ? `Collapse ${sidebarLabel}` : `Expand ${sidebarLabel}`}
      aria-pressed={sidebarOpen}
      onclick={onToggleSidebar}
    >
      <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
        <!-- Panel glyph: outline always; the sliver on this rail's side is
             filled while the Sidebar is shown and hollow while it is hidden. -->
        <rect
          x="2"
          y="3"
          width="12"
          height="10"
          rx="1.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.3"
        />
        <line
          x1={dividerX}
          y1="3"
          x2={dividerX}
          y2="13"
          stroke="currentColor"
          stroke-width="1.3"
        />
        {#if sidebarOpen}
          <rect x={fillX} y="3" width={fillW} height="10" fill="currentColor" opacity="0.8" />
        {/if}
      </svg>
    </button>

    {#if onQuickNav}
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
    {/if}
    {#if onSearch}
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
    {/if}
  </div>

  <!-- Bottom-pinned controls. `bottom` (web: theme toggle) sits just above the
       avatar/login slot, which is reserved + EMPTY on desktop (no `user`
       snippet) and filled by the web viewer with a sign-in / sign-out. -->
  <div class="rail-bottom">
    {#if bottom}{@render bottom()}{/if}
    <div
      class="rail-user"
      data-testid={side === 'left' ? 'rail-user' : 'rail-user-right'}
      aria-hidden={!user}
    >
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
    background: var(--bg-elevated);
  }

  /* The rail draws the single hairline between itself and the shell interior. */
  .activity-rail.left {
    border-right: 1px solid var(--border);
  }

  .activity-rail.right {
    border-left: 1px solid var(--border);
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
