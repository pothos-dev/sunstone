<script lang="ts">
  // Per-Tile header (slice: per-tile-header). A slim strip above the Editor
  // carrying everything that is logically PER-PANE for the active Concept:
  //   - the Concept title + a close affordance (clears the Tile to empty state),
  //   - the Edit toggle (read ⇄ live editing), the single view-mode control
  //     (editing-boolean-edit-toggle),
  //   - Split Right (new Column) / Split Down (new TileSlot in this Column) affordances,
  //   - undo / redo over the active Tile's Document history (shown only while editing),
  //   - the review-diff toggle (working-tree ↔ HEAD),
  //   - Export as PDF.
  //
  // Presentational and thin: it owns no state. All logic (edit toggle, undo/redo,
  // review, export, close, split) lives in App.svelte / Tile.svelte and is passed
  // in as callbacks + reactive flags.

  interface Props {
    /** The active Concept's derived header label ('' when the Tile is empty). */
    title: string;
    /** Whether a Concept is open (gates the per-Concept controls). */
    hasOpenConcept: boolean;
    /** Whether the editor is in live-editing mode (vs read-only reading). */
    editing: boolean;
    /** Whether more than one tile is on screen (gates the Close affordance —
     *  closing the sole tile would just clear it to empty state). */
    multipleTiles: boolean;
    /** Whether there is a previous / next Concept in the Tile's history. */
    canGoBack: boolean;
    canGoForward: boolean;
    onBack: () => void;
    onForward: () => void;
    /** Undo/redo availability over the Tile's Document (body+frontmatter) history. */
    canUndo: boolean;
    canRedo: boolean;
    /** Whether the Concept is currently in review (working-tree ↔ HEAD) mode. */
    reviewActive: boolean;
    /** Whether the review toggle is available (the file has reviewable history). */
    reviewEnabled: boolean;
    /** Tooltip for the review toggle (explains the disabled reason when disabled). */
    reviewTooltip: string;
    /** Clear the Tile to its empty state. */
    onClose: () => void;
    /** Open this Tile's Concept in a new Column to the right. */
    onSplitRight: () => void;
    /** Open this Tile's Concept in a new TileSlot below, in this Column. */
    onSplitDown: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onToggleReview: () => void;
    onExportPdf: () => void;
    /** Toggle live editing on/off for this Concept. */
    onToggleEditing: () => void;
    /** WEB only: show the explicit Save button (editing + unsaved changes). On
     *  desktop this stays false (autosave), so the button never renders. */
    showSave?: boolean;
    /** WEB only: commit the active buffer (flush the Document). */
    onSave?: () => void;
    /** Whether the Properties panel is shown (global `session.propertiesShown`). */
    propertiesShown: boolean;
    /**
     * Toggle the Properties panel, which shows the open Concept's frontmatter.
     * Drives the global `session.propertiesShown` flag (the control moved here
     * from the deleted NavBar; the flag's scope is unchanged — app-wide).
     */
    onToggleProperties: () => void;
  }

  let {
    title,
    hasOpenConcept,
    editing,
    multipleTiles,
    canGoBack,
    canGoForward,
    onBack,
    onForward,
    canUndo,
    canRedo,
    reviewActive,
    reviewEnabled,
    reviewTooltip,
    onClose,
    onSplitRight,
    onSplitDown,
    onUndo,
    onRedo,
    onToggleReview,
    onExportPdf,
    onToggleEditing,
    showSave = false,
    onSave,
    propertiesShown,
    onToggleProperties,
  }: Props = $props();
</script>

<header class="tile-header" data-testid="tile-header" aria-label="Concept header">
  <div class="tile-title-group">
    <!-- Per-Tile navigation history (the Tile owns its own Back/Forward stack). -->
    <div class="btn-group">
      <button
        type="button"
        class="icon-btn"
        data-testid="nav-back"
        title="Back (Ctrl+Alt+Left)"
        aria-label="Back"
        disabled={!canGoBack}
        onclick={onBack}>←</button
      >
      <button
        type="button"
        class="icon-btn"
        data-testid="nav-forward"
        title="Forward (Ctrl+Alt+Right)"
        aria-label="Forward"
        disabled={!canGoForward}
        onclick={onForward}>→</button
      >
    </div>
    <span class="tile-title" data-testid="tile-title" title={title}>{title}</span>
  </div>

  <div class="tile-controls">
    <!-- Undo / redo over the Tile's single body+frontmatter history. Shown only
         while editing — reading mode is read-only, so there is nothing to undo.
         They sit to the LEFT of the Edit toggle. The mousedown-prevent keeps
         clicking a button from blurring/committing an in-progress frontmatter
         edit before the command runs. -->
    {#if editing}
      <div class="btn-group">
        <button
          type="button"
          class="icon-btn"
          data-testid="undo"
          title="Undo (Ctrl+Z)"
          aria-label="Undo"
          disabled={!canUndo}
          onmousedown={(e) => e.preventDefault()}
          onclick={onUndo}>↶</button
        >
        <button
          type="button"
          class="icon-btn"
          data-testid="redo"
          title="Redo (Ctrl+Shift+Z)"
          aria-label="Redo"
          disabled={!canRedo}
          onmousedown={(e) => e.preventDefault()}
          onclick={onRedo}>↷</button
        >
      </div>
    {/if}

    <!-- WEB explicit Save (ticket 08 §4): sits between undo/redo and the Edit
         toggle, shown ONLY while editing with unsaved changes. Its presence IS
         the dirty indicator (no separate dot). Desktop autosaves → never shown.
         The mousedown-prevent keeps the click from blurring a frontmatter edit
         before the flush runs. -->
    {#if showSave}
      <button
        type="button"
        class="text-btn save-btn"
        data-testid="web-save"
        title="Save (Ctrl/Cmd+S)"
        aria-label="Save"
        onmousedown={(e) => e.preventDefault()}
        onclick={onSave}>Save</button
      >
    {/if}

    <!-- Edit toggle: the single view-mode control (editing-boolean-edit-toggle).
         Pressed = live editing (rendered with the cursor line shown raw, editable);
         unpressed = reading (fully rendered, read-only — the default). -->
    <button
      type="button"
      class="text-btn"
      class:active={editing}
      data-testid="edit-toggle"
      title={editing ? 'Editing — click to switch to reading' : 'Edit — switch to live editing'}
      aria-label="Edit"
      aria-pressed={editing}
      disabled={!hasOpenConcept}
      onclick={onToggleEditing}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <!-- pen/pencil glyph: a diagonal body with a nib and its cross-stroke. -->
        <path
          d="M10.5 2.7 13.3 5.5 5.6 13.2 2.5 13.5 2.8 10.4z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linejoin="round"
        />
        <line x1="9.2" y1="4" x2="12" y2="6.8" stroke="currentColor" stroke-width="1.2" />
      </svg>
      Edit</button
    >

    <!-- Properties toggle: shows/hides the open Concept's frontmatter inline.
         Moved here from the deleted NavBar; drives the global
         `session.propertiesShown` flag (app-wide preference). -->
    <button
      type="button"
      class="icon-btn"
      class:active={propertiesShown}
      data-testid="properties-toggle"
      title={propertiesShown ? 'Hide Properties' : 'Show Properties'}
      aria-label="Properties"
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

    <!-- Review changes (working-tree ↔ HEAD): a read-only diff view. Disabled
         with an explanatory tooltip when the Concept has no reviewable history. -->
    <button
      type="button"
      class="icon-btn"
      class:active={reviewActive}
      data-testid="review-toggle"
      title={reviewTooltip}
      aria-label={reviewTooltip}
      aria-pressed={reviewActive}
      disabled={!hasOpenConcept || !reviewEnabled}
      onclick={onToggleReview}
    >
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <!-- git-branch glyph: two commit nodes on a branch line + a fork. -->
        <circle cx="4" cy="3" r="1.6" fill="none" stroke="currentColor" stroke-width="1.2" />
        <circle cx="4" cy="13" r="1.6" fill="none" stroke="currentColor" stroke-width="1.2" />
        <circle cx="12" cy="5.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.2" />
        <line x1="4" y1="4.6" x2="4" y2="11.4" stroke="currentColor" stroke-width="1.2" />
        <path d="M4 8.5 Q4 5.5 10.4 5.5" fill="none" stroke="currentColor" stroke-width="1.2" />
      </svg>
    </button>

    <!-- Export as PDF: render the Concept to static HTML in a clean preview
         window (App.svelte's `exportPdf`), not the virtualized editor. -->
    <button
      type="button"
      class="icon-btn"
      data-testid="export-pdf"
      title="Export as PDF"
      aria-label="Export as PDF"
      disabled={!hasOpenConcept}
      onclick={onExportPdf}
    >
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <path
          d="M4 2.5h5l3 3v8a0 0 0 0 1 0 0H4a0 0 0 0 1 0 0z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linejoin="round"
        />
        <path d="M9 2.5v3h3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
        <path
          d="M8 7.5v4m0 0 1.6-1.6M8 11.5 6.4 9.9"
          fill="none"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>

    <!-- Split affordances: Split Right opens this Tile's Concept in a new Column
         to the right; Split Down opens it in a new TileSlot below, in this Column. -->
    <div class="btn-group">
      <button
        type="button"
        class="icon-btn"
        data-testid="split-right"
        title="Split Right"
        aria-label="Split Right"
        onclick={onSplitRight}
      >
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2" />
          <line x1="8" y1="2.5" x2="8" y2="13.5" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </button>
      <button
        type="button"
        class="icon-btn"
        data-testid="split-down"
        title="Split Down"
        aria-label="Split Down"
        onclick={onSplitDown}
      >
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2" />
          <line x1="1.5" y1="8" x2="14.5" y2="8" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </button>
    </div>

    <!-- Close the Concept: sits at the far right edge, past the split buttons.
         Only shown when more than one tile is on screen — closing the sole tile
         would just clear it to the empty state, so the affordance is pointless. -->
    {#if multipleTiles}
      <button
        type="button"
        class="icon-btn"
        data-testid="tile-close"
        title="Close Concept"
        aria-label="Close Concept"
        disabled={!hasOpenConcept}
        onclick={onClose}>×</button
      >
    {/if}
  </div>
</header>

<style>
  .tile-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 0.4rem;
    /* Wrap the controls onto a second row in narrow tiles (tiling) rather than
       letting them overflow and overlap the title/close affordances. Wide tiles
       stay on one line, so single-tile layout is unchanged. */
    flex-wrap: wrap;
    flex: none;
    /* No horizontal padding: the controls sit flush to the tile edges (aligned
       with the sidebar seams) rather than floating with a weird inset. */
    padding: 0.3rem 0;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elevated);
  }

  .tile-title-group {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
    flex: 1 1 auto;
  }

  .tile-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text);
  }

  .tile-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: none;
  }

  .btn-group {
    display: inline-flex;
    gap: 0.2rem;
  }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.7rem;
    height: 1.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
    font: inherit;
    font-size: 0.95rem;
    cursor: pointer;
    line-height: 1;
    transition: background 0.12s ease;
  }

  .icon-btn:hover:not(:disabled) {
    background: var(--hover);
  }

  .icon-btn.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }

  .icon-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  /* Text buttons (Edit, Save): same height/treatment as the icon buttons but
     sized to their label. */
  .text-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    height: 1.7rem;
    padding: 0 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
    line-height: 1;
    transition: background 0.12s ease;
  }

  .text-btn:hover:not(:disabled) {
    background: var(--hover);
  }

  .text-btn.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }

  .text-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  /* Save is the primary action while editing dirty — give it the accent fill. */
  .save-btn {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
    font-weight: 600;
  }

  .save-btn:hover:not(:disabled) {
    background: var(--accent);
    opacity: 0.9;
  }
</style>
