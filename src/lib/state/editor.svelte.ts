import { Workspace } from '$lib/state/workspace.svelte';
import type { Tile } from '$lib/state/workspace.svelte';

/**
 * Editor facade: the stable surface App.svelte and the tree-CRUD flow use to
 * drive the open Concept, its autosave, and navigation history.
 *
 * Behind it the state is split into two layers (slice: document-tile-state-split):
 *  - a **Document** owns a Concept's buffer, dirty flag, autosave and disk IO,
 *    addressable by path via a `DocumentRegistry`;
 *  - a **Tile** owns the active Concept, navigation history and view state, and
 *    attaches to a Document.
 *
 * This facade delegates to the workspace's single active Tile, so the app
 * behaves byte-identically to the previous `editor` singleton. Later slices add
 * more Tiles; the facade stays the "focused / active Tile" accessor.
 */
class EditorStore {
  #workspace = new Workspace();

  /**
   * The tiling workspace behind the facade. App.svelte reads this to render the
   * layout tree (row of columns of Tiles) and to drive split/close/resize/active
   * — everything that operates on MORE than the single active Tile. The facade
   * getters/methods below stay the "active Tile" surface every existing call site
   * relies on, so they keep working unchanged.
   */
  get workspace(): Workspace {
    return this.#workspace;
  }

  get #tile(): Tile {
    return this.#workspace.activeTile;
  }

  /** bundle-relative path of the open Concept, or null if none. */
  get path(): string | null {
    return this.#tile.activePath;
  }

  /** raw markdown of the open Concept (source of truth while editing). */
  get content(): string {
    return this.#tile.content;
  }

  /** Last open/save error, if any. */
  get error(): string | null {
    return this.#tile.error;
  }

  /** True when there are unsaved edits (a save is pending or in flight). */
  get dirty(): boolean {
    return this.#tile.dirty;
  }

  /** Visited Concept paths; `history[index]` is the current Concept. */
  get history(): readonly string[] {
    return this.#tile.history;
  }

  /** Index of the current entry in `history` (-1 when empty). */
  get index(): number {
    return this.#tile.index;
  }

  /** True when there is a previous Concept to go Back to. */
  get canGoBack(): boolean {
    return this.#tile.canGoBack;
  }

  /** True when there is a forward Concept to advance to. */
  get canGoForward(): boolean {
    return this.#tile.canGoForward;
  }

  /**
   * Optional hook invoked after a successful autosave, once the write has
   * landed (App wires this to slug-anchor rewriting). Propagated to every
   * Document in the workspace.
   */
  set onSaved(cb: ((path: string) => void) | null) {
    this.#workspace.setOnSaved(cb);
  }

  /**
   * Open a Concept by bundle-relative path and load its raw markdown. Pushes a
   * new history entry (truncating forward history). Re-opening the current
   * Concept is a no-op.
   */
  open(path: string): Promise<void> {
    return this.#tile.open(path);
  }

  /** Go to the previous Concept in history, if any. */
  back(): Promise<void> {
    return this.#tile.back();
  }

  /** Re-advance to the next Concept in history, if any. */
  forward(): Promise<void> {
    return this.#tile.forward();
  }

  /** Clear the active Tile to its empty state (flushing any pending autosave). */
  close(): Promise<void> {
    return this.#tile.close();
  }

  /** Record a user edit and schedule a debounced autosave. */
  edit(content: string): void {
    this.#tile.edit(content);
  }

  /** Write the current content to disk immediately (cancels the debounce). */
  flush(): Promise<void> {
    return this.#tile.flush();
  }

  /**
   * EXPLICIT save: writes through the save gate, so frontmatter that does not
   * parse is persisted rather than lost (ADR 0008).
   */
  save(): Promise<void> {
    return this.#tile.save();
  }

  /** Follow the open Concept + history across a rename/move (ALL Tiles). */
  followRename(from: string, to: string): string | null {
    return this.#workspace.followRename(from, to);
  }

  /** React to an external filesystem change on the open Concept (ALL Tiles). */
  onExternalChange(kind: string, paths: string[]): Promise<void> {
    return this.#workspace.onExternalChange(kind, paths);
  }

  /**
   * WEB concurrency (ticket 08 §3): silently reload the active Concept from disk
   * after a clean external change. No-op when the buffer is dirty (Document
   * guards it) or nothing is open.
   */
  reloadActiveExternal(): Promise<void> {
    return this.#tile.activeDocument?.reloadExternal() ?? Promise.resolve();
  }

  /**
   * WEB concurrency (ticket 08 §3): drop unsaved edits on the active Concept and
   * reload the on-disk version ("Discard my changes & reload"). Overrides the
   * dirty guard; no-op when nothing is open.
   */
  discardActiveEdits(): Promise<void> {
    return this.#tile.activeDocument?.discardLocalEdits() ?? Promise.resolve();
  }
}

export const editor = new EditorStore();
