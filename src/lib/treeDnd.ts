import { dirname } from './path';

/**
 * Pure drop-legality rule for dragging tree rows into folders (slice: tree-dnd).
 * Kept DOM-free so it can be unit-tested; the `treeDnd` rune store
 * (`state/treeDnd.svelte.ts`) delegates here.
 *
 * Whether moving `from` into folder `toDir` is a legal drop. Rejects no-ops
 * (already in `toDir`) and the impossible cases of dropping a folder into itself
 * or one of its own descendants. A name collision in the target is left to the
 * backend, which surfaces it as a `treeActions` error. `toDir` is `''` for the
 * Bundle root.
 */
export function canDrop(from: string, toDir: string): boolean {
  if (from === '') return false; // the root itself is never draggable
  if (dirname(from) === toDir) return false; // already there
  if (toDir === from || toDir.startsWith(`${from}/`)) return false; // into self/descendant
  return true;
}

/** The slice of the `treeDnd` store a drop zone reads and writes. */
export interface DropZoneState {
  dragging: string | null;
  dropTarget: string | null;
  end(): void;
}

/** The DragEvent members a drop zone touches (a structural subset, for tests). */
export interface DropZoneEvent {
  preventDefault(): void;
  stopPropagation(): void;
  dataTransfer: { dropEffect: string } | null;
  currentTarget: EventTarget | null;
  relatedTarget: EventTarget | null;
}

export interface DropZoneOptions {
  /** The shared drag state (the `treeDnd` store). */
  state: DropZoneState;
  /** The folder this zone drops into (`''` = Bundle root); read per event. */
  dir: () => string;
  /** Perform the move of `from` into `toDir` (a legal drop). */
  move: (from: string, toDir: string) => void;
  /**
   * A zone nested inside another (a tree row inside the root zone) stops the
   * event so the outer zone doesn't ALSO handle it.
   */
  nested?: boolean;
  /** After a legal dragover claimed the zone. */
  onOver?: () => void;
  /** When the pointer actually exits the zone, and on drop. */
  onExit?: () => void;
}

/**
 * The dragover/dragleave/drop trio shared by every tree drop zone (each folder
 * row and the Explorer's root zone): validate against `canDrop`, highlight via
 * `dropTarget`, and move on drop. A missing `preventDefault` on dragover is
 * what tells the browser "not a drop target", so illegal hovers return early.
 */
export function dropZoneHandlers({ state, dir, move, nested = false, onOver, onExit }: DropZoneOptions) {
  return {
    ondragover(e: DropZoneEvent) {
      const from = state.dragging;
      const toDir = dir();
      if (from === null || !canDrop(from, toDir)) return;
      e.preventDefault();
      if (nested) e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      state.dropTarget = toDir;
      onOver?.();
    },
    ondragleave(e: DropZoneEvent) {
      // Ignore leaves into our own descendants; only clear when the pointer
      // actually exits this zone.
      const cur = e.currentTarget as Node | null;
      const rel = e.relatedTarget as Node | null;
      if (cur && rel && typeof cur.contains === 'function' && cur.contains(rel)) return;
      onExit?.();
      if (state.dropTarget === dir()) state.dropTarget = null;
    },
    ondrop(e: DropZoneEvent) {
      e.preventDefault();
      if (nested) e.stopPropagation();
      onExit?.();
      const from = state.dragging;
      const toDir = dir();
      state.end();
      if (from !== null && canDrop(from, toDir)) move(from, toDir);
    },
  };
}
