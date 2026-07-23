<script lang="ts">
  // Global app chrome (slice: per-tile-header). The NavBar holds ONLY controls
  // that are global to the whole app — not to any one Tile: the left/right
  // Sidebar collapse toggles and a global Properties show/hide toggle. The
  // per-Concept / per-Tile controls (the Edit toggle, undo/redo, review, export,
  // close, split, history) live in the TileHeader above the Editor.
  //
  // (Search and Quick-nav are keyboard-driven today — Ctrl+Shift+F / Ctrl+K —
  // and theme follows the OS, so those global affordances have no button here
  // yet; the seam is this bar when they grow one.)

  interface Props {
    leftSidebarOpen: boolean;
    rightSidebarOpen: boolean;
    /** Whether the global Properties panel is shown (drives per-tile Properties). */
    propertiesShown: boolean;
    onToggleLeft: () => void;
    onToggleRight: () => void;
    /**
     * Toggle the global Properties show/hide flag. When on, EVERY visible tile
     * renders its own Concept's frontmatter inline; when off, no tile shows any
     * Properties chrome. Persisted in the session store.
     */
    onToggleProperties: () => void;
  }

  let {
    leftSidebarOpen,
    rightSidebarOpen,
    propertiesShown,
    onToggleLeft,
    onToggleRight,
    onToggleProperties,
  }: Props = $props();
</script>

<nav class="nav-bar" aria-label="Global controls">
  <div class="nav-left">
    <button
      type="button"
      class="nav-btn"
      data-testid="sidebar-toggle"
      title={leftSidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
      aria-label={leftSidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
      aria-pressed={leftSidebarOpen}
      onclick={onToggleLeft}
    >
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <rect
          x="1.5"
          y="2.5"
          width="13"
          height="11"
          rx="1.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.2"
        />
        <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" stroke-width="1.2" />
        <rect
          x="1.5"
          y="2.5"
          width="4.5"
          height="11"
          rx="1.5"
          fill="currentColor"
          opacity={leftSidebarOpen ? 0.5 : 0}
          stroke="none"
        />
      </svg>
    </button>
  </div>
  <div class="nav-right">
    <!-- Global Properties show/hide toggle: flips `session.propertiesShown`, which
         gates the inline Properties panel in every visible tile at once. -->
    <button
      type="button"
      class="nav-btn"
      class:active={propertiesShown}
      data-testid="properties-panel-toggle"
      title={propertiesShown ? 'Hide Properties' : 'Show Properties'}
      aria-label={propertiesShown ? 'Hide Properties' : 'Show Properties'}
      aria-pressed={propertiesShown}
      onclick={onToggleProperties}
    >
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <!-- sliders glyph: two horizontal rails with knobs (properties/settings). -->
        <line x1="2.5" y1="5" x2="13.5" y2="5" stroke="currentColor" stroke-width="1.2" />
        <line x1="2.5" y1="11" x2="13.5" y2="11" stroke="currentColor" stroke-width="1.2" />
        <circle cx="6" cy="5" r="1.8" fill="var(--bg-elevated)" stroke="currentColor" stroke-width="1.2" />
        <circle cx="10.5" cy="11" r="1.8" fill="var(--bg-elevated)" stroke="currentColor" stroke-width="1.2" />
      </svg>
    </button>
    <button
      type="button"
      class="nav-btn"
      data-testid="right-sidebar-toggle"
      title={rightSidebarOpen ? 'Collapse Outline & Backlinks' : 'Expand Outline & Backlinks'}
      aria-label={rightSidebarOpen ? 'Collapse Outline & Backlinks' : 'Expand Outline & Backlinks'}
      aria-pressed={rightSidebarOpen}
      onclick={onToggleRight}
    >
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <rect
          x="1.5"
          y="2.5"
          width="13"
          height="11"
          rx="1.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.2"
        />
        <line x1="10" y1="2.5" x2="10" y2="13.5" stroke="currentColor" stroke-width="1.2" />
        <rect
          x="10"
          y="2.5"
          width="4.5"
          height="11"
          rx="1.5"
          fill="currentColor"
          opacity={rightSidebarOpen ? 0.5 : 0}
          stroke="none"
        />
      </svg>
    </button>
  </div>
</nav>

<style>
  /* Two-track global bar: left Sidebar toggle at the start, the Properties +
     right-Sidebar toggles at the end. */
  .nav-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--border);
  }

  .nav-left {
    display: flex;
    gap: 0.35rem;
  }

  .nav-right {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .nav-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.9rem;
    height: 1.9rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    line-height: 1;
    transition: background 0.12s ease;
  }

  .nav-btn:hover:not(:disabled) {
    background: var(--hover);
  }

  .nav-btn.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }

  .nav-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
</style>
