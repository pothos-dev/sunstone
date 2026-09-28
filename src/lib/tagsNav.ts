// Flattened-visible-row math for the Tags Section's keyboard navigation
// (slice: tags-multi-expand-keyboard-nav). Pure; no DOM/state.
//
// The Tags Section is a TWO-level tree (docs/GLOSSARY.md): tag roots, each of which —
// when expanded — reveals the Concepts carrying that tag as nested leaves.
// Arrowing the keyboard Focused item moves over the VISIBLE rows only: every tag
// root, plus the concept leaves of the EXPANDED tags, in render order
// `[tag root, (its concept leaves if expanded)…, next tag root, …]`.
//
// `$lib/treeNav.flattenVisible` is `TreeNode`-specific (the Bundle tree), so it
// doesn't fit the tag model; this is the small tags-specific flatten. The index
// math itself (clamp, no wrap — a tree is spatial) is shared: re-export
// `nextIndexClamped`/`prevIndexClamped` from `treeNav` so callers have one
// import and the behaviour stays identical to the Explorer.

import type { TagCount } from '$lib/types';
import { nextIndexClamped, prevIndexClamped } from '$lib/treeNav';

export { nextIndexClamped, prevIndexClamped };

/**
 * One row in the flattened Tags visible-rows list. A row is identified by its
 * `key` (unique across the flattened list — see `rowKey`), which is what the
 * Focused-item rune stores and the DOM `data-row-key` mirrors.
 */
export interface TagRow {
  /** Stable unique key for this row across the visible list (see `rowKey`). */
  key: string;
  /** True for a tag-root row, false for a concept-leaf row. */
  isTag: boolean;
  /** For a tag row: the tag name. For a leaf: the parent tag's name. */
  tag: string;
  /** For a leaf row: the bundle-relative Concept path. Empty for a tag row. */
  path: string;
  /** For a tag row: whether it is currently expanded. (false for leaves) */
  expanded: boolean;
}

/** Separator between a tag and a Concept path in a leaf row key. A TAB can't
 *  occur in a tag name or a bundle-relative path, so the key is unambiguous, and
 *  unlike NUL it survives `CSS.escape` for the DOM `data-row-key` selector. */
const KEY_SEP = '\t';

/**
 * The stable per-row key. A tag root is keyed by its tag; a concept leaf is
 * keyed by `tag<TAB>path` so the SAME Concept appearing under two different tags
 * yields two distinct rows (each its own Focused-item target).
 */
export function rowKey(tag: string, path: string | null): string {
  return path === null ? tag : `${tag}${KEY_SEP}${path}`;
}

/**
 * Flatten the Tags two-level tree into the ordered list of VISIBLE rows: each
 * tag root in `tags` order, followed by its concept leaves when the tag is
 * expanded. `expanded(tag)` reports whether a tag is open; `conceptsOf(tag)`
 * returns the (cached) Concept paths for an expanded tag — an empty list when
 * not yet loaded, which simply yields no leaves until the cache fills.
 */
export function flattenTagRows(
  tags: TagCount[],
  expanded: (tag: string) => boolean,
  conceptsOf: (tag: string) => string[],
): TagRow[] {
  const rows: TagRow[] = [];
  for (const { tag } of tags) {
    const isOpen = expanded(tag);
    rows.push({ key: rowKey(tag, null), isTag: true, tag, path: '', expanded: isOpen });
    if (isOpen) {
      for (const path of conceptsOf(tag)) {
        rows.push({ key: rowKey(tag, path), isTag: false, tag, path, expanded: false });
      }
    }
  }
  return rows;
}

/** The row index of `key` in `rows`, or -1 when absent. */
export function indexOfKey(rows: TagRow[], key: string | null): number {
  if (key === null) return -1;
  return rows.findIndex((r) => r.key === key);
}

/**
 * Drop the expanded tags and cached per-tag Concept lists whose tag is no
 * longer `live` (e.g. its last Concept was untagged on disk). Each field is the
 * pruned copy, or `null` when nothing was dropped — so a caller holding them in
 * reactive state reassigns only on a real change. Shared by the desktop
 * `TagBrowser` and the web `WebTags`.
 */
export function pruneToLiveTags<V>(
  live: ReadonlySet<string>,
  expanded: ReadonlySet<string>,
  cache: ReadonlyMap<string, V>,
): { expanded: Set<string> | null; cache: Map<string, V> | null } {
  const nextExpanded = new Set<string>();
  for (const t of expanded) if (live.has(t)) nextExpanded.add(t);
  const nextCache = new Map<string, V>();
  for (const [t, v] of cache) if (live.has(t)) nextCache.set(t, v);
  return {
    expanded: nextExpanded.size !== expanded.size ? nextExpanded : null,
    cache: nextCache.size !== cache.size ? nextCache : null,
  };
}
