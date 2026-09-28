<script lang="ts">
  /**
   * The tiling editor layout: a ROW OF COLUMNS, each a vertical STACK of Tiles,
   * with draggable dividers between columns and between tiles. Renders
   * `workspace.layout` (sizing math lives in the pure `tileLayout.ts`) and drives
   * split / close / resize / activate on the workspace.
   *
   * It renders the columns directly into the parent's `.editor-area` flex row
   * (no wrapper), which stays in App as the single 'editor' Region container.
   * App reaches the Tiles through the exported handles: `activeTile()` for
   * active-Tile editor concerns, `focusTile` for Alt+arrow grid moves, and
   * `focusActiveWhenReady` to land focus after an open.
   */
  import { editor } from '$lib/state/editor.svelte';
  import Tile from '$lib/components/Tile.svelte';
  import {
    resizeColumns as layoutResizeColumns,
    resizeTiles as layoutResizeTiles,
    MIN_WEIGHT,
  } from '$lib/tileLayout';
  import { startDividerDrag } from '$lib/dividerDrag';
  import { retryFrames } from '$lib/retryFrames';

  interface Props {
    /** New-Concept create: the path whose Properties should focus `type`. */
    focusTypeForPath: string | null;
    /** A Tile header breadcrumb asked to show `folder` in the Explorer. */
    onRevealFolder: (folder: string) => void;
    /** The ACTIVE Tile's viewport-probe line (drives the Outline highlight). */
    onActiveViewportLine: (line: number | null) => void;
  }

  let { focusTypeForPath, onRevealFolder, onActiveViewportLine }: Props = $props();

  const workspace = editor.workspace;

  // One imperative handle per live Tile component, keyed by Tile id (bound in the
  // layout `{#each}`).
  let tileRefs = $state<Record<string, ReturnType<typeof Tile>>>({});

  // Total tiles on screen; the per-Tile Close affordance only appears when there
  // is more than one (closing the last tile would just clear it to empty state).
  const tileCount = $derived(
    workspace.layout.columns.reduce((n, col) => n + col.tiles.length, 0),
  );

  /**
   * The handle of the Tile for `workspace.activeId` (reactive). App delegates
   * active-Tile editor concerns to it — focus, outline scroll, undo/redo, find,
   * review, and the slug-anchor save hook.
   */
  export function activeTile(): ReturnType<typeof Tile> | undefined {
    return tileRefs[workspace.activeId];
  }

  /**
   * Move keyboard focus to tile `id`: make it the active Tile (so Outline /
   * Backlinks / Properties, which track the active Tile, follow) and focus its
   * CodeMirror view. Retries across frames, since the target tile's view may
   * still be building. Focusing the view fires its `focusin`, which keeps the
   * 'editor' Region active.
   */
  export function focusTile(id: string): void {
    workspace.setActive(id);
    retryFrames(() => {
      const ref = tileRefs[id];
      if (!ref?.hasView()) return false;
      ref.focusView();
      return true;
    }, 10);
  }

  /**
   * Focus the active Tile's CodeMirror view once it exists (retry across frames,
   * since the view (re)builds reactively and may be null the next microtask).
   */
  export function focusActiveWhenReady(): void {
    retryFrames(() => {
      const ref = activeTile();
      if (!ref?.hasView()) return false;
      ref.focusView();
      return true;
    }, 10);
  }

  // Close a tile, then land keyboard focus in the neighbour that inherited the
  // active slot (workspace.closeTile picks it). Closing the last tile clears the
  // Tile to the empty state (no view to focus — focusActiveWhenReady no-ops).
  async function closeTileAndFocus(id: string) {
    await workspace.closeTile(id);
    focusActiveWhenReady();
  }

  // --- Column / tile divider drags (pure size math in `tileLayout.ts`) --------
  // Each drag captures the layout snapshot at pointer-down and applies the total
  // pointer delta (as a fraction of the container axis) from that base, so the
  // clamp is idempotent — dragging past a neighbour's minimum stops cleanly and
  // reversing recovers. Assigning `workspace.layout` keeps every column keyed by
  // id, so the live CodeMirror views survive the re-render (only weights change).
  // A column divider sits directly in the editor-area row, so its parent is the
  // container whose width the columns share.
  function onColumnDividerDown(e: PointerEvent, boundaryIndex: number) {
    if (e.button !== 0) return;
    const areaEl = (e.currentTarget as HTMLElement).parentElement;
    if (!areaEl) return;
    const base = workspace.layout;
    startDividerDrag({
      event: e,
      axis: 'x',
      size: areaEl.getBoundingClientRect().width,
      onFraction: (delta) => {
        workspace.layout = layoutResizeColumns(base, boundaryIndex, delta, MIN_WEIGHT);
      },
    });
  }

  function onTileDividerDown(e: PointerEvent, columnIndex: number, boundaryIndex: number) {
    if (e.button !== 0) return;
    const columnEl = (e.currentTarget as HTMLElement).parentElement;
    if (!columnEl) return;
    const base = workspace.layout;
    startDividerDrag({
      event: e,
      axis: 'y',
      size: columnEl.getBoundingClientRect().height,
      onFraction: (delta) => {
        workspace.layout = layoutResizeTiles(base, columnIndex, boundaryIndex, delta, MIN_WEIGHT);
      },
    });
  }
</script>

{#each workspace.layout.columns as col, ci (col.id)}
  <div class="editor-column" style="flex-grow: {col.weight}">
    {#each col.tiles as slot, ti (slot.id)}
      {@const tile = workspace.tileById(slot.id)}
      {#if tile}
        <div class="tile-slot" style="flex-grow: {slot.weight}">
          <Tile
            bind:this={tileRefs[tile.id]}
            {tile}
            active={tile.id === workspace.activeId}
            multipleTiles={tileCount > 1}
            {focusTypeForPath}
            onActivate={() => workspace.setActive(tile.id)}
            onSplitRight={() => {
              workspace.setActive(tile.id);
              workspace.splitRight();
            }}
            onSplitDown={() => {
              workspace.setActive(tile.id);
              workspace.splitDown();
            }}
            onClose={() => void closeTileAndFocus(tile.id)}
            {onRevealFolder}
            onViewportLine={(line) => {
              // Only the active Tile feeds the Outline — it is the Tile the
              // Outline lists headings for.
              if (tile.id === workspace.activeId) onActiveViewportLine(line);
            }}
          />
        </div>
      {/if}
      {#if ti < col.tiles.length - 1}
        <div
          class="tile-divider"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize tiles"
          data-testid="tile-divider"
          onpointerdown={(e) => onTileDividerDown(e, ci, ti)}
        ></div>
      {/if}
    {/each}
  </div>
  {#if ci < workspace.layout.columns.length - 1}
    <div
      class="column-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize columns"
      data-testid="column-divider"
      onpointerdown={(e) => onColumnDividerDown(e, ci)}
    ></div>
  {/if}
{/each}

<style>
  /* A column: a vertical stack of tiles. `flex-grow` carries its weight; a shared
     `flex-basis: 0` makes the grow ratios the exact size ratios. */
  .editor-column {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* One tile's slot in a column; the inline `flex-grow` carries its weight. */
  .tile-slot {
    position: relative;
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* Draggable dividers between columns / between tiles. A comfortable hit-strip
     (a few px) drawn transparent, with a centred hairline via a pseudo so the
     visible seam stays 1px while the whole strip is grabbable. The cursor signals
     the drag axis; hovering brightens the hairline to the accent. */
  .column-divider,
  .tile-divider {
    flex: none;
    position: relative;
    background: transparent;
    touch-action: none;
  }

  .column-divider {
    width: 7px;
    cursor: col-resize;
  }

  .tile-divider {
    height: 7px;
    cursor: row-resize;
  }

  .column-divider::after,
  .tile-divider::after {
    content: '';
    position: absolute;
    background: var(--border);
    transition: background 0.12s ease;
  }

  .column-divider::after {
    top: 0;
    bottom: 0;
    left: 50%;
    width: 1px;
    transform: translateX(-50%);
  }

  .tile-divider::after {
    left: 0;
    right: 0;
    top: 50%;
    height: 1px;
    transform: translateY(-50%);
  }

  .column-divider:hover::after,
  .tile-divider:hover::after {
    background: var(--accent);
  }
</style>
