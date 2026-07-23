// Heading-identity tracking for slug-anchor rewriting (slice: slug-anchor-rewrite).
//
// This is the "link data structure" that lets us rewrite anchors when a heading
// changes: a CodeMirror StateField that remembers each heading's identity — its
// line-start POSITION plus the slug it had at the last baseline — and maps those
// positions forward through every edit. Because positions are remapped through
// the actual change set (not re-derived by matching text), we can tell a heading
// RENAME ("Installation" → "Setup", same identity, slug changed) from a heading
// DELETE (its tracked position no longer sits on a heading — identity dropped, so
// its inbound links are meant to break, not silently repoint).
//
// The editor doc holds only the BODY (frontmatter is split off, ADR 0003), so
// `scanHeadings` runs with a zero frontmatter offset and its 1-based lines map
// straight onto the CodeMirror document.
//
// Flow (driven from App.svelte over the autosave seam):
//   - baseline is snapshotted on Concept open (StateField `create`, re-run on the
//     fresh state a Concept switch builds) and after each rewrite
//     (`commitAnchorBaseline`);
//   - after a save, `pendingAnchorRenames(view)` diffs the surviving tracked
//     headings against the current document and yields {from,to} slug renames;
//   - the host rewrites same-file anchors in-buffer + inbound anchors via the
//     backend, then calls `commitAnchorBaseline` to re-baseline.

import { StateEffect, StateField, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { scanHeadings } from '$lib/wasm/exports';
import type { AnchorRename } from '$lib/types';

/** One tracked heading: its line-start position and its slug at the baseline. */
interface TrackedHeading {
  /** Char offset of the heading line's start, remapped through every edit. */
  pos: number;
  /** The heading's slug when the baseline was taken. */
  baselineSlug: string;
}

/** Effect: re-snapshot the baseline from the current document. */
export const resetAnchorBaseline = StateEffect.define<null>();

/** Snapshot the current headings as tracked identities (line-start pos + slug). */
function snapshot(state: EditorState): TrackedHeading[] {
  const doc = state.doc.toString();
  return scanHeadings(doc).map((h) => ({
    pos: state.doc.line(h.line).from,
    baselineSlug: h.slug,
  }));
}

/**
 * Tracks each heading's identity across edits. `create` seeds the baseline from
 * the initial document; a `resetAnchorBaseline` effect re-seeds it; every other
 * document change remaps the tracked positions forward. The `1` bias makes an
 * insertion AT the line start (e.g. a new heading typed above) push the tracked
 * position onto the following (original) heading rather than the new content, so
 * identity follows the right heading. Edits INSIDE the heading text land after
 * the line start and leave the position unchanged regardless of bias.
 */
export const anchorTracking = StateField.define<TrackedHeading[]>({
  create: (state) => snapshot(state),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(resetAnchorBaseline)) return snapshot(tr.state);
    if (!tr.docChanged) return value;
    return value.map((h) => ({ ...h, pos: tr.changes.mapPos(h.pos, 1) }));
  },
});

/**
 * Heading-slug renames since the baseline: for each tracked heading whose
 * identity survives (its remapped position still sits on a heading line), emit
 * `{ from: oldSlug, to: currentSlug }` when the slug changed. Current slugs come
 * from a full-document scan, so GitHub's de-duplication counters (`notes`,
 * `notes-1`) stay correct even when a rename cascades. Deleted headings (no
 * current heading at the tracked position) yield nothing — their links break.
 */
export function pendingAnchorRenames(view: EditorView): AnchorRename[] {
  const state = view.state;
  const tracked = state.field(anchorTracking);
  // Map each current heading's line-start position to its (deduped) slug.
  const doc = state.doc.toString();
  const bySlugPos = new Map<number, string>();
  for (const h of scanHeadings(doc)) {
    bySlugPos.set(state.doc.line(h.line).from, h.slug);
  }
  const renames: AnchorRename[] = [];
  const seen = new Set<string>();
  for (const t of tracked) {
    const current = bySlugPos.get(t.pos);
    if (current === undefined) continue; // identity lost (heading deleted / moved off line)
    // An emptied heading (`## ` with no text → empty slug) is treated like a
    // deletion, not a rename to `#`: repointing inbound links to an empty anchor
    // is never useful, so leave them alone (they break rather than repoint).
    if (current === '' || t.baselineSlug === '') continue;
    if (current !== t.baselineSlug && !seen.has(t.baselineSlug)) {
      renames.push({ from: t.baselineSlug, to: current });
      seen.add(t.baselineSlug);
    }
  }
  return renames;
}

/** Re-baseline the tracker to the current headings (after a rewrite). */
export function commitAnchorBaseline(view: EditorView): void {
  view.dispatch({ effects: resetAnchorBaseline.of(null) });
}
