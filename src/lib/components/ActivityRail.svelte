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
  // Presentational only: it owns no business state. The toggle / Bundle
  // switcher / quick-nav / search / titles / font-size buttons call back into the parent, which flips the SAME flags the
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
    /** Toggle the Bundle switcher (same flag as Ctrl/Cmd+O); desktop only. */
    onSwitchBundle?: () => void;
    /** Whether the Bundle switcher is open (drives the button's pressed state). */
    switcherOpen?: boolean;
    /** Whether Concepts and folders are labelled by their frontmatter `title`. */
    titlesShown?: boolean;
    /** Flip {@link titlesShown}; the button is shown only when this is passed. */
    onToggleTitles?: () => void;
    /** Current UI zoom as a percentage, shown in the font-size buttons' tooltips. */
    zoomPercent?: number;
    /** Step the UI zoom (same as Ctrl/Cmd +/-). The joined font-size button is
     *  shown only when both are passed. */
    onZoomIn?: () => void;
    onZoomOut?: () => void;
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
    onSwitchBundle,
    switcherOpen = false,
    titlesShown = true,
    onToggleTitles,
    zoomPercent = 100,
    onZoomIn,
    onZoomOut,
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

    {#if onSwitchBundle}
      <!-- Bundle switcher: just below the Sidebar toggle, so its popover
           opens beside the top of the rail. A mouse click does not
           take focus, so the Region that had it stays the overlay's opener and
           a cancel (Escape / outside click) returns focus there. -->
      <button
        type="button"
        class="rail-btn"
        class:active={switcherOpen}
        data-testid="rail-bundle-switcher"
        title="Switch Bundle (Ctrl+O)"
        aria-label="Switch Bundle"
        aria-haspopup="dialog"
        aria-expanded={switcherOpen}
        onmousedown={(e) => e.preventDefault()}
        onclick={onSwitchBundle}
      >
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
          <!-- stacked folders glyph -->
          <path
            d="M2 5.5V12a1 1 0 0 0 1 1h9.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linecap="round"
          />
          <path
            d="M4 3.5h2.6l1.2 1.3H13a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    {/if}

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
    {#if onToggleTitles}
      <button
        type="button"
        class="rail-btn"
        class:active={titlesShown}
        data-testid="rail-titles"
        title={titlesShown ? 'Show filenames instead of titles' : 'Show titles instead of filenames'}
        aria-label="Show titles"
        aria-pressed={titlesShown}
        onclick={onToggleTitles}
      >
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
          <!-- "T" glyph: label by title. -->
          <line x1="3.5" y1="3.5" x2="12.5" y2="3.5" stroke="currentColor" stroke-width="1.6" />
          <line x1="8" y1="3.5" x2="8" y2="12.5" stroke="currentColor" stroke-width="1.6" />
        </svg>
      </button>
    {/if}
  </div>

  <!-- Bottom-pinned controls. `bottom` (web: theme toggle) sits just above the
       avatar/login slot, which is reserved + EMPTY on desktop (no `user`
       snippet) and filled by the web viewer with a sign-in / sign-out. -->
  <div class="rail-bottom">
    {#if onZoomIn && onZoomOut}
      <!-- Font size: one joined button, larger on top, smaller below. -->
      <div class="rail-joined" role="group" aria-label="Font size" data-testid="rail-zoom">
        <button
          type="button"
          class="rail-btn"
          data-testid="rail-zoom-in"
          title="Larger text (Ctrl++) · {zoomPercent}%"
          aria-label="Larger text"
          onclick={onZoomIn}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <line x1="3.5" y1="8" x2="12.5" y2="8" stroke="currentColor" stroke-width="1.5" />
            <line x1="8" y1="3.5" x2="8" y2="12.5" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </button>
        <button
          type="button"
          class="rail-btn"
          data-testid="rail-zoom-out"
          title="Smaller text (Ctrl+-) · {zoomPercent}%"
          aria-label="Smaller text"
          onclick={onZoomOut}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <line x1="3.5" y1="8" x2="12.5" y2="8" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </button>
      </div>
    {/if}
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

  /* A toggle that is on reads in the accent colour. */
  .rail-btn.active {
    color: var(--accent);
    opacity: 1;
  }

  .rail-btn:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: -2px;
    opacity: 1;
  }

  /* Two rail buttons fused into one outlined control, split by a hairline. */
  .rail-joined {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .rail-joined .rail-btn {
    height: 1.6rem;
    border-radius: 0;
  }

  .rail-joined .rail-btn + .rail-btn {
    border-top: 1px solid var(--border);
  }

  /* Reserved bottom slot: kept in the layout (so the rail always reserves the
     space) but paints nothing on desktop. */
  .rail-user {
    flex: none;
    width: 2rem;
    height: 2rem;
  }
</style>
