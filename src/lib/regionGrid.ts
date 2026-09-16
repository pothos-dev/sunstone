// Region grid geometry + directional-movement math (pure; no DOM/state).
//
// The six app Regions form a fixed 3×2 grid (see docs/GLOSSARY.md "Region" and the
// region-focus-backbone ticket):
//
//        col 0 (left)   col 1 (editor)   col 2 (right)
//   row0  Explorer       Properties       Outline
//   row1  Tags           Editor           Backlinks
//
// This module owns ONLY the index math for moving the active Region with
// Alt+arrows / Alt+hjkl. It is deliberately DOM-free and state-free: the
// `focus` store (state/focus.svelte.ts) feeds it the grid coordinates plus a
// visibility predicate and applies the resulting move by focusing a Region.
//
// Two behaviours live here:
//  - directional movement that SKIPS hidden Regions and CLAMPS at grid edges
//    (no wrap), and
//  - sticky per-column landing: moving left/right returns to the Region you
//    were last in for the destination column (the caller supplies + updates the
//    per-column memory).

/** A Region's identity. Orthogonal to Pane/Section (docs/GLOSSARY.md). */
export type RegionId =
  | 'explorer'
  | 'tags'
  | 'frontmatter'
  | 'editor'
  | 'outline'
  | 'backlinks';

/** A movement direction (already normalised from arrows / hjkl). */
export type Direction = 'left' | 'right' | 'up' | 'down';

/** Fixed grid position of every Region: `[col, row]`, both 0-based. */
export const REGION_CELL: Record<RegionId, readonly [col: number, row: number]> = {
  explorer: [0, 0],
  tags: [0, 1],
  frontmatter: [1, 0],
  editor: [1, 1],
  outline: [2, 0],
  backlinks: [2, 1],
};

/** All Region ids, in a stable order (column-major, top row first). */
export const ALL_REGIONS: readonly RegionId[] = [
  'explorer',
  'tags',
  'frontmatter',
  'editor',
  'outline',
  'backlinks',
];

const NUM_COLS = 3;
const NUM_ROWS = 2;

/** The Region at grid cell `[col, row]`, or null if none (every cell is filled
 *  in this grid, but the lookup stays total for safety). */
export function regionAt(col: number, row: number): RegionId | null {
  for (const id of ALL_REGIONS) {
    const [c, r] = REGION_CELL[id];
    if (c === col && r === row) return id;
  }
  return null;
}

/**
 * Compute the Region to move to from `from` in `direction`, given a visibility
 * predicate (`isVisible`) and the per-column landing memory (`columnMemory`:
 * the Region last focused in each column, indexed by column).
 *
 * Rules (region-focus-backbone):
 *  - up/down move WITHIN the current column to the adjacent row, skipping hidden
 *    Regions, and CLAMP at the top/bottom edge (no move past the last visible
 *    Region in the column).
 *  - left/right change COLUMN. The destination column's landing Region is its
 *    sticky memory when that Region is visible; otherwise the nearest visible
 *    Region in that column (preferring the same row, then scanning the column).
 *    Columns with NO visible Region are skipped entirely; movement clamps at the
 *    first/last column that has any visible Region.
 *
 * Returns the destination `RegionId`, or `null` when the move is clamped (no
 * change). A `null` result means "stay put".
 */
export function move(
  from: RegionId,
  direction: Direction,
  isVisible: (id: RegionId) => boolean,
  columnMemory: ReadonlyArray<RegionId | null>,
): RegionId | null {
  const [col, row] = REGION_CELL[from];

  if (direction === 'up' || direction === 'down') {
    const step = direction === 'down' ? 1 : -1;
    for (let r = row + step; r >= 0 && r < NUM_ROWS; r += step) {
      const id = regionAt(col, r);
      if (id && isVisible(id)) return id;
    }
    return null; // clamped at the column edge
  }

  // left / right: change column, skipping columns with no visible Region.
  const step = direction === 'right' ? 1 : -1;
  for (let c = col + step; c >= 0 && c < NUM_COLS; c += step) {
    const landing = pickColumnLanding(c, row, isVisible, columnMemory[c] ?? null);
    if (landing) return landing;
  }
  return null; // clamped: no visible Region in any further column
}

/**
 * Choose which Region to land on when entering `col`. Prefer the column's
 * sticky `memory` Region when it is visible; otherwise prefer the Region on the
 * incoming `preferredRow`, then scan the rest of the column top-to-bottom.
 * Returns null when the column has no visible Region.
 */
export function pickColumnLanding(
  col: number,
  preferredRow: number,
  isVisible: (id: RegionId) => boolean,
  memory: RegionId | null,
): RegionId | null {
  if (memory && REGION_CELL[memory][0] === col && isVisible(memory)) return memory;
  // Same row first, then the remaining rows in order.
  const rows = [preferredRow, ...Array.from({ length: NUM_ROWS }, (_, r) => r)];
  for (const r of rows) {
    const id = regionAt(col, r);
    if (id && isVisible(id)) return id;
  }
  return null;
}

/**
 * Map a movement key to a Region-movement [`Direction`], or `null` when the key
 * isn't a movement key. Accepts both arrow keys and the Vim-style `hjkl`. Used
 * by the Alt-chord Region navigation in the app shell.
 */
export function directionForKey(key: string): Direction | null {
  switch (key) {
    case 'ArrowLeft':
    case 'h':
      return 'left';
    case 'ArrowDown':
    case 'j':
      return 'down';
    case 'ArrowUp':
    case 'k':
      return 'up';
    case 'ArrowRight':
    case 'l':
      return 'right';
    default:
      return null;
  }
}
