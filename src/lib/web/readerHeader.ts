// The anonymous web reader's Tile header (wr-1): the reader renders the
// desktop `TileHeader`, and this pure module derives what it needs that the
// desktop gets from `Tile.svelte` — the folder breadcrumbs for the open
// Concept, and what a breadcrumb click does in the reader. No DOM, IPC or runes.

import { dirname } from '$lib/path';
import { reservedKind } from '$lib/reserved';
import { folderCrumbs, indexCrumbs, type IndexedCrumb } from '$lib/tileTitle';
import type { TreeNode } from '$lib/types';
import type { Drawer } from './mobileLayout';

/**
 * The header breadcrumbs for the Concept at `selected` (`null` = nothing open):
 * one per ancestor folder, outermost first, named and indexed against `tree`
 * like the desktop header. The reader's label (`conceptTitle`) always names a
 * folder `index.md` after its folder (title, H1 or folder name), so the index's
 * own folder is dropped from the crumbs — `guide/index.md` reads `Guide`, not
 * `guide/Guide`.
 */
export function readerCrumbs(selected: string | null, tree: TreeNode | null): IndexedCrumb[] {
  if (selected === null) return [];
  let dir = dirname(selected);
  if (dir !== '' && reservedKind(selected) === 'index') dir = dirname(dir);
  return indexCrumbs(folderCrumbs(dir), tree);
}

/**
 * What a breadcrumb click does in the reader. A crumb whose folder has an
 * `index.md` opens it (unless that is the open Concept); the folder is always
 * revealed in the Explorer. When nothing is opened on a narrow screen, the
 * Explorer lives in a closed drawer, so the drawer opens to show the reveal.
 */
export function readerCrumbAction(
  crumb: IndexedCrumb,
  selected: string | null,
  narrow: boolean,
): { open: string | null; drawer: Drawer } {
  const open = crumb.index !== null && crumb.index !== selected ? crumb.index : null;
  return { open, drawer: open === null && narrow ? 'left' : null };
}
