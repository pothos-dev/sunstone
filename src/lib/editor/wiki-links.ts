import {
  EditorView,
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  wikiLinks,
  type WikiLinkResolvedTarget,
  type WikiLinksConfig,
} from '@atomic-editor/editor';
import { indexStore } from '$lib/state/index.svelte';

/**
 * The `name` and `#anchor` of a raw wikilink inner text (`name|alias#anchor`).
 * The alias begins at the first `|`; the anchor at the first `#` in the name
 * part. Resolution itself lives on the wasm handle (`resolveWikilink`); this is
 * the small display-side split the label + open scroll need. Mirrors the Rust
 * `wikilink::parse_target` for these two fields.
 */
function splitWikilinkParts(raw: string): { name: string; anchor: string | null } {
  let namePart = raw;
  const pipe = namePart.indexOf('|');
  if (pipe !== -1) namePart = namePart.slice(0, pipe);
  const hash = namePart.indexOf('#');
  if (hash === -1) return { name: namePart, anchor: null };
  return { name: namePart.slice(0, hash), anchor: namePart.slice(hash + 1) };
}

// ---------------------------------------------------------------------------
// Wikilink rendering (ADR-0004) — `[[name]]` as an OPTIONAL, name-based
// secondary link format alongside primary markdown links.
//
// We reuse atomic-editor's built-in `wikiLinks` CodeMirror extension and supply
// a Sunstone `resolve`/`onOpen` adapter:
//   - `resolve(target)` runs the pure, synchronous name-based resolver
//     (`resolveWikilink`) against the same cached index `exists()` the
//     broken-link decoration uses, and reports `resolved` / `missing`.
//   - `onOpen(target)` navigates in-app (same mechanism as markdown links) and
//     best-effort scrolls to an `#anchor` heading.
//
// The extension's resolve-cache has NO invalidation API, so the host wraps the
// extension in a `Compartment` and reconfigures it (`reconfigureWikiLinks`)
// whenever the index changes — recreating the StateField clears the stale
// cache and re-resolves the visible links. This piggybacks on the SAME index
// signal that refreshes broken markdown links.
//
// Embeds (`![[ ]]`) are deferred (ADR-0004) — the upstream scanner already
// matches only `[[ ]]`, so `![[ ]]` renders as a literal `!` plus a wikilink;
// that is acceptable for v1 and embeds are out of scope.
// ---------------------------------------------------------------------------

/** Context the wikilink adapter needs from app state. Resolution + the concept
 *  set now live on the wasm handle (`indexStore`); only the open Concept path
 *  and the in-app navigation callback stay app-supplied. */
export interface WikiLinkContext {
  /** Bundle-relative path of the open Concept (the link's source for resolution). */
  currentPath: () => string;
  /**
   * Open a resolved wikilink: `path` is the bundle-relative target, `anchor` is
   * the `#heading` text (without the `#`), or `null` when absent. The host
   * navigates in-app and best-effort scrolls to the heading.
   */
  open: (path: string, anchor: string | null) => void;
}

/** Resolve a raw `[[target]]` to a status + label, or `null` (broken). */
function resolveTarget(ctx: WikiLinkContext, target: string): WikiLinkResolvedTarget | null {
  const resolved = indexStore.resolveWikilink(ctx.currentPath(), target);
  // Unresolved by the name index, OR resolves to a path absent from the index
  // (same existence check the broken markdown-link decoration uses) → missing.
  if (!resolved || !indexStore.exists(resolved.path)) return null;
  return { target, label: labelFor(target, resolved.path), status: 'resolved' };
}

/**
 * Display label for a resolved bare wikilink (the aliased `[[a|b]]` case keeps
 * its own label via the upstream decoration). Prefer the author's written name
 * (Obsidian shows what was typed); fall back to the resolved file's basename.
 */
function labelFor(rawTarget: string, path: string): string {
  const { name } = splitWikilinkParts(rawTarget);
  const written = name.trim();
  if (written !== '') return written;
  // Pure same-file anchor `[[#heading]]` → name is empty; use the file basename.
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.replace(/\.md$/i, '');
}

/**
 * Build the `wikiLinks` extension configured with the Sunstone adapter. NO
 * `suggest` (autocomplete is deferred, ADR-0004). `openOnClick` so a plain
 * click navigates, matching how rendered markdown links open.
 */
export function wikiLinksExtension(ctx: WikiLinkContext): Extension {
  const config: WikiLinksConfig = {
    // `resolve` is async upstream; our resolver is synchronous, so wrap it.
    resolve: (target) => Promise.resolve(resolveTarget(ctx, target)),
    onOpen: (target) => {
      const { anchor } = splitWikilinkParts(target);
      const resolved = indexStore.resolveWikilink(ctx.currentPath(), target);
      if (resolved) ctx.open(resolved.path, anchor && anchor.trim() !== '' ? anchor : null);
    },
    openOnClick: true,
  };
  return [wikiLinks(config), brokenAliasWikiLinkOverlay(ctx)];
}

// ---------------------------------------------------------------------------
// Broken aliased-wikilink overlay.
//
// Upstream `wikiLinks` styles ALL aliased links (`[[target|label]]`) as
// resolved and never runs `resolve()` on them — so a broken `[[missing|x]]`
// would read as a valid link. To make BOTH the bare and aliased cases reflect
// broken-ness, we overlay a `cm-atomic-wiki-link-missing` mark on the label of
// any aliased wikilink whose target does not resolve. Bare links are already
// handled by the upstream resolver. Mirrors the broken markdown-link plugin.
// ---------------------------------------------------------------------------

const ALIAS_MISSING_MARK = Decoration.mark({ class: 'cm-atomic-wiki-link-missing' });
const WIKI_LINK_RE = /\[\[([^\]\n]+?)\]\]/g;

function computeBrokenAliasWikiLinks(view: EditorView, ctx: WikiLinkContext): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    for (const m of text.matchAll(WIKI_LINK_RE)) {
      const body = m[1];
      const pipe = body.indexOf('|');
      if (pipe === -1) continue; // bare links: upstream resolver handles them.
      const matchStart = from + (m.index ?? 0);
      // Skip while the cursor is inside the link (upstream reveals raw source).
      const linkFrom = matchStart;
      const linkTo = matchStart + m[0].length;
      const insideCursor = view.state.selection.ranges.some(
        (r) => Math.min(r.from, r.to) < linkTo && Math.max(r.from, r.to) > linkFrom,
      );
      if (insideCursor) continue;
      const resolved = indexStore.resolveWikilink(ctx.currentPath(), body);
      if (resolved && indexStore.exists(resolved.path)) continue; // resolves → leave as-is.
      // Mark the label range (after `[[…|`, before `]]`) as missing.
      const labelStart = matchStart + 2 + pipe + 1;
      const labelEnd = matchStart + 2 + body.length;
      if (labelStart < labelEnd) builder.add(labelStart, labelEnd, ALIAS_MISSING_MARK);
    }
  }
  return builder.finish();
}

/**
 * Overlay decoration that flags broken ALIASED wikilinks (the upstream resolver
 * skips them). Recomputes on doc / viewport / selection changes. Reconfigured
 * with the rest of the wikilink extension on index change (fresh `ctx` closure
 * is captured per `wikiLinksExtension` build).
 */
function brokenAliasWikiLinkOverlay(ctx: WikiLinkContext): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = computeBrokenAliasWikiLinks(view, ctx);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = computeBrokenAliasWikiLinks(update.view, ctx);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** Distinct styling for broken/unresolved wikilinks — matches `.cm-broken-link`.
 *  Colour the descendant label spans too (with `!important`) so the danger red
 *  wins over `atomicLinkTheme` / the base-text highlight on the inner span. */
export const wikiLinkTheme = EditorView.theme({
  [[
    '.cm-atomic-wiki-link-missing',
    '.cm-atomic-wiki-link-missing span',
    '.cm-atomic-wiki-link-unresolved',
    '.cm-atomic-wiki-link-unresolved span',
  ].join(', ')]: {
    color: 'var(--danger) !important',
    textUnderlineOffset: '2px',
  },
  '.cm-atomic-wiki-link-missing, .cm-atomic-wiki-link-unresolved': {
    textDecoration: 'underline dashed var(--danger)',
  },
});
