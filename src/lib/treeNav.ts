// Flattened-visible-row math for Explorer keyboard navigation (pure; no DOM/state).
//
// The Explorer renders the Bundle tree as nested rows; arrowing the keyboard
// Focused item moves over the VISIBLE rows only — children of a collapsed folder
// are skipped, and reserved files (index.md / log.md) are never ordinary rows
// (they surface as folder-header affordances). This module flattens the tree
// into that exact visible order and owns the index math.
//
// Unlike `listNav.ts` (which WRAPS for the modal palettes) movement here CLAMPS
// at the ends: a tree is spatial, so arrowing past the last row stays put rather
// than jumping to the first. Tags reuses this in a later slice, so it lives in
// its own pure module with unit tests.

import type { TreeNode } from '$lib/types';
import { isMarkdownName, stripMd } from '$lib/path';
import { isReservedFile, reservedKind, type ReservedKind } from '$lib/reserved';

/** One row in the flattened visible-rows list. */
export interface VisibleRow {
  /** bundle-relative path of the node this row renders. */
  path: string;
  /** True for a folder row, false for a Concept (`.md`) row. */
  isDir: boolean;
  /** Indentation depth (root's ordinary children are depth 0). */
  depth: number;
  /** bundle-relative path of the containing folder ('' = Bundle root). */
  parentPath: string;
  /** For a folder row: whether it is currently expanded. (false for files) */
  expanded: boolean;
}

/**
 * The ordinary children of `node` in render order: folders and Concepts (`.md`),
 * excluding reserved files and any non-markdown file. The single source of truth
 * for this filter, reused by `Tree.svelte` / the App root listing so the
 * flattened order matches the DOM exactly.
 */
export function ordinaryChildren(node: TreeNode): TreeNode[] {
  return (node.children ?? []).filter(
    (c) => c.isDir || (isMarkdownName(c.name) && !isReservedFile(c.path)),
  );
}

/** A reserved file surfaced as a folder affordance: its path and kind. */
export interface ReservedEntry {
  path: string;
  kind: ReservedKind;
}

/** Canonical display order of reserved-file affordances. */
const RESERVED_ORDER: ReservedKind[] = ['index', 'log'];

/**
 * The reserved files (`index.md`/`log.md`) directly under a node, as ordered
 * `{ path, kind }` entries (index before log). Used to render a folder's
 * reserved-file affordances; the ordinary children come from `ordinaryChildren`.
 */
export function reservedChildren(node: TreeNode): ReservedEntry[] {
  return (node.children ?? [])
    .filter((c) => !c.isDir && isReservedFile(c.path))
    .map((c) => ({ path: c.path, kind: reservedKind(c.path) as ReservedKind }))
    .sort((a, b) => RESERVED_ORDER.indexOf(a.kind) - RESERVED_ORDER.indexOf(b.kind));
}

/**
 * The path of the `index.md` directly under `node`, or `null` when it has none
 * — what a folder-name click opens (desktop Explorer, web tree).
 */
export function indexChild(node: TreeNode): string | null {
  return reservedChildren(node).find((r) => r.kind === 'index')?.path ?? null;
}

/**
 * Flatten the Bundle tree into the ordered list of VISIBLE rows: a depth-first
 * walk over the ordinary children of `root`, descending into a folder only when
 * `isExpanded(folderPath)` is true. `root` is the Bundle-root node (`path: ''`)
 * and is NOT itself a row — only its descendants are.
 */
export function flattenVisible(
  root: TreeNode | null,
  isExpanded: (path: string) => boolean,
): VisibleRow[] {
  const rows: VisibleRow[] = [];
  if (root === null) return rows;

  const walk = (node: TreeNode, depth: number, parentPath: string): void => {
    for (const child of ordinaryChildren(node)) {
      const expanded = child.isDir && isExpanded(child.path);
      rows.push({
        path: child.path,
        isDir: child.isDir,
        depth,
        parentPath,
        expanded,
      });
      if (child.isDir && expanded) walk(child, depth + 1, child.path);
    }
  };

  walk(root, 0, '');
  return rows;
}

/** The row index of `path` in `rows`, or -1 when absent. */
export function indexOfPath(rows: VisibleRow[], path: string | null): number {
  if (path === null) return -1;
  return rows.findIndex((r) => r.path === path);
}

/**
 * The path of a sensible Focused-item neighbour after the row at `path` is
 * removed: the row that visually takes its place — the NEXT visible row, or the
 * PREVIOUS one when the removed row was last. Returns null when there is no
 * neighbour (the removed row was the only one, or `path` isn't a visible row).
 * Used to keep the Explorer cursor on a real row after a delete (slice:
 * explorer-crud-keybindings). Computed against the pre-delete `rows`.
 */
export function neighborAfterRemoval(rows: VisibleRow[], path: string): string | null {
  const i = indexOfPath(rows, path);
  if (i < 0) return null;
  // Skip past the removed row's descendants (deeper-indented following rows) so
  // a folder's child can't be chosen as its own replacement.
  const removed = rows[i];
  let next = i + 1;
  while (next < rows.length && rows[next].depth > removed.depth) next++;
  if (next < rows.length) return rows[next].path;
  if (i > 0) return rows[i - 1].path;
  return null;
}

/**
 * Next index moving DOWN, CLAMPED at the last row (no wrap). Returns 0 for an
 * empty list. A `from` of -1 (nothing focused) lands on the first row.
 */
export function nextIndexClamped(from: number, length: number): number {
  if (length === 0) return 0;
  if (from < 0) return 0;
  return Math.min(from + 1, length - 1);
}

/**
 * Previous index moving UP, CLAMPED at the first row (no wrap). Returns 0 for an
 * empty list. A `from` of -1 (nothing focused) lands on the first row.
 */
export function prevIndexClamped(from: number, length: number): number {
  if (length === 0) return 0;
  if (from < 0) return 0;
  return Math.max(from - 1, 0);
}

/**
 * The row index a linear-movement key moves the Focused item to over a list of
 * `length` rows, or `null` when `key` is not one: ArrowDown / `j` and ArrowUp /
 * `k` step one row CLAMPED at the ends (see `nextIndexClamped` /
 * `prevIndexClamped`; `current` -1 = nothing focused lands on the first row),
 * Home / End jump to the first / last row. Also `null` for an empty list. The
 * one key table the Explorer, Tags, Outline and Backlinks Regions share (the
 * palettes WRAP instead and never claim `j`/`k` — see `listNav.listKeyIntent`).
 */
export function linearMove(key: string, current: number, length: number): number | null {
  if (length === 0) return null;
  switch (key) {
    case 'ArrowDown':
    case 'j':
      return nextIndexClamped(current, length);
    case 'ArrowUp':
    case 'k':
      return prevIndexClamped(current, length);
    case 'Home':
      return 0;
    case 'End':
      return length - 1;
    default:
      return null;
  }
}

/**
 * What a handled keypress in a tree Region (Explorer, Tags) asks for, applied by
 * the nav store: move the Focused item to the row with id `focus`, set the
 * Focused row's expanded state to `expand`, and/or `open` the Focused Concept.
 * An empty intent is a handled no-op (the key is still consumed).
 */
export interface RowKeyIntent<Id> {
  focus?: Id;
  expand?: boolean;
  open?: boolean;
}

/**
 * The Explorer's key decision over its visible `rows` with the Focused item at
 * index `current` (-1 = none), or `null` when the key is not handled:
 *
 * * linear movement — see `linearMove`;
 * * Right / `l`: collapsed folder → expand; expanded folder → into its first
 *   child; file → no-op;
 * * Left / `h`: expanded folder → collapse; otherwise → its parent folder
 *   (root-level rows have none: no-op);
 * * Right/Left with nothing focused → the first row;
 * * Enter / Space: folder → toggle; file → open. Unhandled with nothing focused.
 */
export function explorerKeyIntent(
  key: string,
  rows: VisibleRow[],
  current: number,
): RowKeyIntent<string> | null {
  const move = linearMove(key, current, rows.length);
  if (move !== null) return { focus: rows[move].path };
  const row: VisibleRow | undefined = current >= 0 ? rows[current] : undefined;
  switch (key) {
    case 'ArrowRight':
    case 'l': {
      if (!row) return rows.length ? { focus: rows[0].path } : null;
      if (!row.isDir) return {};
      if (!row.expanded) return { expand: true };
      // The next row is this folder's first descendant when there is one.
      const next = rows[current + 1];
      return next && next.parentPath === row.path ? { focus: next.path } : {};
    }
    case 'ArrowLeft':
    case 'h': {
      if (!row) return rows.length ? { focus: rows[0].path } : null;
      if (row.isDir && row.expanded) return { expand: false };
      return row.parentPath !== '' ? { focus: row.parentPath } : {};
    }
    case 'Enter':
    case ' ':
      if (!row) return null;
      return row.isDir ? { expand: !row.expanded } : { open: true };
    default:
      return null;
  }
}

/**
 * The `index.md` directly inside `folder` (bundle-relative, `''` for the root),
 * or null when the folder has none or is not in the tree. Used by the Tile
 * header breadcrumbs, which open a folder's index when it has one.
 */
export function folderIndexPath(root: TreeNode | null, folder: string): string | null {
  const node = findFolder(root, folder);
  return node ? indexChild(node) : null;
}

/** The frontmatter `title` of the `index.md` directly under folder `node`, if any. */
export function folderTitle(node: TreeNode): string | null {
  const index = indexChild(node);
  return node.children?.find((c) => c.path === index)?.title ?? null;
}

/**
 * The Explorer label for `node`. With `useTitles` (the default), a Concept shows
 * its frontmatter `title` and a folder its `index.md`'s title; otherwise, or
 * when there is none, a Concept shows its filename without the `.md` extension
 * and a folder its own name.
 */
export function treeLabel(node: TreeNode, useTitles = true): string {
  if (node.isDir) return (useTitles && folderTitle(node)) || node.name;
  return (useTitles && node.title) || stripMd(node.name);
}

/** The folder node at bundle-relative `folder` (`''` = the root), or null. */
export function findFolder(root: TreeNode | null, folder: string): TreeNode | null {
  let node: TreeNode | undefined = root ?? undefined;
  if (node && folder !== '') {
    const parts = folder.split('/');
    for (let i = 0; i < parts.length && node; i++) {
      const path = parts.slice(0, i + 1).join('/');
      node = node.children?.find((c) => c.isDir && c.path === path);
    }
  }
  return node ?? null;
}

/**
 * Set (or clear, with `null`) the `title` of the file node at `path` in place,
 * so a saved title edit shows in the Explorer without re-walking the Bundle.
 * Returns whether a node was found.
 */
export function setNodeTitle(root: TreeNode, path: string, title: string | null): boolean {
  const walk = (node: TreeNode): boolean => {
    if (!node.isDir) {
      if (node.path !== path) return false;
      if (title === null) delete node.title;
      else node.title = title;
      return true;
    }
    return (node.children ?? []).some(walk);
  };
  return walk(root);
}
