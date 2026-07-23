import { remapPath } from '$lib/path';
import { Document, DocumentRegistry } from '$lib/state/document.svelte';
import {
  EMPTY_HISTORY,
  canGoBack,
  canGoForward,
  goBack,
  goForward,
  pushEntry,
  remapHistory,
  type NavHistory,
} from '$lib/state/navHistory';
import {
  singleTileLayout,
  allTileIds,
  columnId,
  splitRight as layoutSplitRight,
  splitDown as layoutSplitDown,
  closeTile as layoutCloseTile,
  resizeColumns as layoutResizeColumns,
  resizeTiles as layoutResizeTiles,
  MIN_WEIGHT,
  type Column,
  type Layout,
  type TileSlot,
} from '$lib/tileLayout';
import { rememberTile, type ColumnMemory } from '$lib/tileNav';
import { serializeLayout, type StoredLayout } from '$lib/state/layoutPersist';
import { DEFAULT_EDITOR_MODE, type EditorMode } from '$lib/editor/cm';

/** Monotonic Tile-id source: ids are opaque, stable, and never reused. */
let tileIdCounter = 0;
function nextTileId(): string {
  return `tile-${++tileIdCounter}`;
}

/**
 * WEB-only async gate consulted before a DIRTY active buffer is left — a Concept
 * switch (`#loadInto`) or a Tile close (ticket 08 §4). The gate resolves the
 * dirty buffer via the three-way Save/Discard/Cancel modal and returns `true` to
 * proceed (it has already Saved or Discarded) or `false` to ABORT the navigation.
 *
 * `null` on the DESKTOP build (never registered): the outgoing Document is
 * flushed exactly as before, so desktop navigation/close is byte-identical. Only
 * `WebAppShellIsland` registers a gate (guarded on `__SUNSTONE_WEB__`).
 */
export type DirtyLeaveGate = (doc: Document) => Promise<boolean>;
let dirtyLeaveGate: DirtyLeaveGate | null = null;

/** Register (or clear) the web dirty-leave gate. See {@link DirtyLeaveGate}. */
export function setDirtyLeaveGate(gate: DirtyLeaveGate | null): void {
  dirtyLeaveGate = gate;
}

/**
 * A Tile is a *view onto* Concepts: it holds the active Concept, this Tile's
 * navigation history, and (later) its scroll/cursor and view-mode. It attaches
 * to a Document — the buffer/autosave layer — via the shared `DocumentRegistry`,
 * so the same Concept opened in two Tiles shares one live buffer.
 *
 * Navigation is browser-style (see `navHistory`): opening pushes a new entry
 * (truncating forward history), Back/Forward move the cursor. Re-opening the
 * already-current Concept is a no-op. Every navigation flushes the outgoing
 * Document's pending autosave first, so switching Concepts never loses edits.
 */
export class Tile {
  #registry: DocumentRegistry;

  /** Opaque, stable id — the layout tree addresses this Tile by it. */
  readonly id: string;
  /** bundle-relative path of the active Concept, or null if none. */
  activePath = $state<string | null>(null);
  /**
   * This Tile's view-mode (the boolean `editing` vs `read`). Owned here (not in
   * the Tile.svelte component) so it is part of the persisted layout shape and
   * survives a relaunch. A fresh Tile defaults to `DEFAULT_EDITOR_MODE`; a split
   * inherits its source's mode; a restore sets it from the stored layout.
   */
  mode = $state<EditorMode>(DEFAULT_EDITOR_MODE);
  /** This Tile's navigation history (immutable value; see navHistory.ts). */
  #history = $state<NavHistory>(EMPTY_HISTORY);

  constructor(registry: DocumentRegistry, id: string = nextTileId()) {
    this.#registry = registry;
    this.id = id;
  }

  /** The Document backing the active Concept, or null when nothing is open. */
  get activeDocument(): Document | null {
    return this.activePath === null ? null : this.#registry.get(this.activePath);
  }

  /** Raw markdown of the active Concept ('' when nothing is open). */
  get content(): string {
    return this.activeDocument?.content ?? '';
  }

  /** Last open/save error of the active Concept, if any. */
  get error(): string | null {
    return this.activeDocument?.error ?? null;
  }

  /** True when the active Concept has unsaved edits. */
  get dirty(): boolean {
    return this.activeDocument?.dirty ?? false;
  }

  /** Visited Concept paths of this Tile (current entry at `index`). */
  get history(): readonly string[] {
    return this.#history.entries;
  }

  /** Cursor into `history` (-1 when empty). */
  get index(): number {
    return this.#history.index;
  }

  /** True when there is a previous Concept to go Back to. */
  get canGoBack(): boolean {
    return canGoBack(this.#history);
  }

  /** True when there is a forward Concept to advance to. */
  get canGoForward(): boolean {
    return canGoForward(this.#history);
  }

  /**
   * Open a Concept by bundle-relative path and load its raw markdown. Pushes a
   * new history entry (truncating forward history). Re-opening the
   * already-current Concept is a no-op (no duplicate history entry).
   */
  async open(path: string): Promise<void> {
    if (path === this.activePath) return;
    await this.#loadInto(path);
    if (this.activePath !== path) return; // load did not settle here; skip history
    this.#history = pushEntry(this.#history, path);
  }

  /**
   * Attach this Tile to a Concept that is ALREADY open in another Tile, WITHOUT
   * reloading it from disk. Used by Split Right / Split Down: the source Tile's
   * Document is live in the shared registry (and may carry unsaved edits), so a
   * `load()` would clobber the buffer. We just point at the same path — the
   * getter resolves to the same shared Document — and push a history entry so the
   * clone starts with its own one-entry history.
   */
  adopt(path: string): void {
    this.activePath = path;
    this.#history = pushEntry(this.#history, path);
  }

  /** Go to the previous Concept in history, if any. */
  async back(): Promise<void> {
    if (!this.canGoBack) return;
    const target = this.#history.entries[this.#history.index - 1];
    await this.#loadInto(target);
    if (this.activePath === target) this.#history = goBack(this.#history);
  }

  /** Re-advance to the next Concept in history, if any. */
  async forward(): Promise<void> {
    if (!this.canGoForward) return;
    const target = this.#history.entries[this.#history.index + 1];
    await this.#loadInto(target);
    if (this.activePath === target) this.#history = goForward(this.#history);
  }

  /**
   * Resolve the OUTGOING active Document before a navigation/close. Desktop (and
   * web with a clean buffer): flush any pending write, then proceed. Web with a
   * DIRTY buffer + a registered {@link DirtyLeaveGate}: run the gate (three-way
   * Save/Discard/Cancel) and honour its verdict — `false` aborts the caller so
   * navigation/close stays put. Returns whether the caller may proceed.
   */
  async requestLeave(): Promise<boolean> {
    const doc = this.activeDocument;
    if (dirtyLeaveGate && doc?.dirty) return dirtyLeaveGate(doc);
    await doc?.flush();
    return true;
  }

  /**
   * Attach the Tile to the Document at `path` and load it from disk. Resolves the
   * outgoing Document first (flush on desktop; the dirty-leave gate on web) so
   * navigating never silently loses edits. A web gate CANCEL aborts the load.
   */
  async #loadInto(path: string): Promise<void> {
    if (!(await this.requestLeave())) return;
    const doc = this.#registry.get(path);
    await doc.load();
    this.activePath = path;
  }

  /**
   * Clear the Tile to its empty state: flush the outgoing Document's pending
   * autosave (so closing never loses edits), then detach the active Concept.
   * The navigation history is left intact — Back can still re-open the last
   * Concept. With a single Tile this returns the editor to the empty
   * "Select a Concept" placeholder.
   */
  async close(): Promise<void> {
    if (!(await this.requestLeave())) return;
    this.activePath = null;
  }

  /** Record a user edit into the active Document (schedules autosave). */
  edit(content: string): void {
    this.activeDocument?.edit(content);
  }

  /** Flush the active Document's pending autosave to disk immediately. */
  async flush(): Promise<void> {
    await this.activeDocument?.flush();
  }

  /**
   * Follow the active Concept and history across a rename/move. Rewrites the
   * active path and any affected history entries to the new location, and
   * re-keys the backing Documents, so the Tile keeps pointing at the same
   * Concept (no reload — content is unchanged on disk). Returns the new active
   * path when anything was affected, else null.
   */
  followRename(from: string, to: string): string | null {
    const { history, changed } = remapHistory(this.#history, from, to);
    this.#history = history;

    const openNext = this.activePath === null ? null : remapPath(this.activePath, from, to);
    if (openNext !== null) this.activePath = openNext;

    this.#registry.rename(from, to);

    return changed || openNext !== null ? (this.activePath ?? null) : null;
  }

  /**
   * React to an external filesystem change on the active Concept. If it was
   * removed, detach the Tile (clearing the view); otherwise reload the buffer
   * from disk (unless there are unsaved local edits). Other paths are ignored
   * here — the tree refresh is handled separately in App.svelte.
   */
  async onExternalChange(kind: string, paths: string[]): Promise<void> {
    const open = this.activePath;
    if (open === null || !paths.includes(open)) return;

    if (kind === 'removed') {
      this.#registry.drop(open);
      this.activePath = null;
      return;
    }

    await this.activeDocument?.reloadExternal();
  }
}

/**
 * The workspace holds the Tiles, the shared Document pool, and the TILING LAYOUT
 * — a row of columns, each a vertical stack of tiles (see `tileLayout.ts`). A
 * Tile is addressable by its id; the layout references those ids. Tiles attach to
 * Documents via the shared registry, so the SAME Concept open in two tiles shares
 * one live buffer (an edit/autosave in one reflects in the others).
 *
 * `activeId` names the focused tile; `activeTile` is the Tile the `editor` facade
 * (and thus Outline / Backlinks / Properties) tracks. Splitting clones the active
 * Tile's Concept into a new tile (adopting the shared Document without a reload);
 * closing a tile focuses a neighbour, and closing the last tile clears it to the
 * empty state (keeping the Tile + its history — Back can still re-open).
 */
export class Workspace {
  #registry = new DocumentRegistry();
  #tiles = new Map<string, Tile>();

  /** The tiling layout (a row of columns of tiles), by Tile id. */
  layout = $state<Layout>({ columns: [] });
  /** The focused tile's Tile id. */
  activeId = $state<string>('');

  /**
   * Per-column sticky landing memory: the tile last focused in each column, by
   * column id (see `tileNav`). Updated whenever a tile becomes active, so
   * Alt+Left/Right movement returns to the tile you were last on in a column.
   * Plain field (not a rune): read only at movement time, nothing renders it.
   */
  #columnMemory: ColumnMemory = {};

  constructor() {
    const tile = this.#create();
    this.layout = singleTileLayout(tile.id);
    this.activeId = tile.id;
  }

  #create(): Tile {
    const tile = new Tile(this.#registry);
    this.#tiles.set(tile.id, tile);
    return tile;
  }

  /** The focused Tile (always a live Tile — the layout never has zero tiles). */
  get activeTile(): Tile {
    const tile = this.#tiles.get(this.activeId);
    // Defensive: fall back to any tile if the active id ever dangles.
    return tile ?? this.#tiles.values().next().value!;
  }

  /** Look up a Tile by id (used by the layout renderer). */
  tileById(id: string): Tile | undefined {
    return this.#tiles.get(id);
  }

  /** The per-column sticky landing memory (read by the Alt+arrow grid nav). */
  get columnMemory(): ColumnMemory {
    return this.#columnMemory;
  }

  /**
   * Make the tile `id` the focused/active Tile and record it as its column's
   * sticky tile. No-op for an unknown id.
   */
  setActive(id: string): void {
    if (!this.#tiles.has(id)) return;
    this.activeId = id;
    this.#columnMemory = rememberTile(this.#columnMemory, this.layout, id);
  }

  /**
   * Split Right: clone the active Tile's Concept into a NEW COLUMN to the right,
   * and focus it. The clone adopts the shared Document (no reload). An empty
   * active Tile yields an empty new tile.
   */
  splitRight(): void {
    const source = this.activeTile;
    const tile = this.#create();
    tile.mode = source.mode;
    if (source.activePath !== null) tile.adopt(source.activePath);
    this.layout = layoutSplitRight(this.layout, source.id, tile.id);
    this.activeId = tile.id;
  }

  /**
   * Split Down: clone the active Tile's Concept into a NEW TILE below it in the
   * current column, and focus it.
   */
  splitDown(): void {
    const source = this.activeTile;
    const tile = this.#create();
    tile.mode = source.mode;
    if (source.activePath !== null) tile.adopt(source.activePath);
    this.layout = layoutSplitDown(this.layout, source.id, tile.id);
    this.activeId = tile.id;
  }

  /**
   * Close the tile `id`. The LAST remaining tile is cleared to its empty state
   * (Tile + history preserved — matching the single-Tile close), rather than
   * removed. A non-last tile is removed, its space redistributed, and a
   * neighbour focused if the closed tile was active.
   */
  async closeTile(id: string): Promise<void> {
    const tile = this.#tiles.get(id);
    if (!tile) return;
    if (allTileIds(this.layout).length <= 1) {
      await tile.close();
      return;
    }
    // Resolve a dirty buffer (web gate; desktop flush) before removing the tile;
    // a web CANCEL aborts the close.
    if (!(await tile.requestLeave())) return;
    const { layout, focusId } = layoutCloseTile(this.layout, id);
    this.#tiles.delete(id);
    this.layout = layout;
    if (this.activeId === id && focusId !== null) this.activeId = focusId;
  }

  /** Drag the boundary between columns `index` and `index + 1` by `delta`. */
  resizeColumns(index: number, delta: number): void {
    this.layout = layoutResizeColumns(this.layout, index, delta, MIN_WEIGHT);
  }

  /** Drag the boundary between tiles `index`/`index + 1` in a column by `delta`. */
  resizeTiles(columnIndex: number, index: number, delta: number): void {
    this.layout = layoutResizeTiles(this.layout, columnIndex, index, delta, MIN_WEIGHT);
  }

  /**
   * Follow a rename/move across EVERY Tile (each rewrites its own active path +
   * history; the shared registry is re-keyed once). Returns the ACTIVE Tile's new
   * path when anything was affected, else null — the surface App/treeActions use.
   */
  followRename(from: string, to: string): string | null {
    let activeResult: string | null = null;
    for (const tile of this.#tiles.values()) {
      const r = tile.followRename(from, to);
      if (tile.id === this.activeId) activeResult = r;
    }
    return activeResult;
  }

  /** Broadcast an external filesystem change to EVERY Tile. */
  async onExternalChange(kind: string, paths: string[]): Promise<void> {
    await Promise.all([...this.#tiles.values()].map((p) => p.onExternalChange(kind, paths)));
  }

  /** Set the post-save hook on every Document in the pool. */
  setOnSaved(cb: ((path: string) => void) | null): void {
    this.#registry.setOnSaved(cb);
  }

  /**
   * Snapshot the workspace as a plain, ID-free `StoredLayout` for persistence:
   * every column (order + weight), every tile (order + weight + its Tile's
   * Concept path + view-mode) and the active tile. Thin over the pure
   * `serializeLayout`; reads the reactive layout/tile state so an `$effect`
   * observing it re-persists on any layout-relevant change.
   */
  snapshotLayout(): StoredLayout {
    return serializeLayout(this.layout, this.activeId, (id) => {
      const tile = this.#tiles.get(id);
      return tile ? { path: tile.activePath, mode: tile.mode } : undefined;
    });
  }

  /**
   * Rebuild the workspace from a persisted `StoredLayout`: mint a fresh Tile per
   * stored tile, restore its view-mode, open its Concept (a missing/absent path
   * lands in the Tile's graceful not-found state — it never wedges startup), and
   * set the active tile. Per-tile navigation history and scroll/cursor are NOT
   * restored (out of scope): each Tile starts with a fresh one-entry history at
   * its Concept. Await resolves once every tile's Concept has loaded.
   */
  async restore(stored: StoredLayout): Promise<void> {
    this.#tiles.clear();
    this.#columnMemory = {};
    const opens: Promise<void>[] = [];
    let activeId = '';

    const columns: Column[] = stored.columns.map((sc, ci) => {
      const tiles: TileSlot[] = sc.tiles.map((st, ti) => {
        const tile = this.#create();
        tile.mode = st.mode;
        // A stored path that no longer exists resolves to the Document's
        // not-found state (Document.load catches); swallow here so one bad tile
        // can't reject the whole restore.
        if (st.path !== null) opens.push(tile.open(st.path).catch(() => {}));
        if (ci === stored.active[0] && ti === stored.active[1]) activeId = tile.id;
        return { id: tile.id, weight: st.weight };
      });
      return { id: columnId(tiles[0].id), weight: sc.weight, tiles };
    });

    this.layout = { columns };
    this.activeId = activeId !== '' ? activeId : columns[0].tiles[0].id;
    await Promise.all(opens);
  }
}
