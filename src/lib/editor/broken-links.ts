import {
  EditorView,
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { StateEffect, RangeSetBuilder, type Extension } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { indexStore } from '$lib/state/index.svelte';

// ---------------------------------------------------------------------------
// Broken-link decoration (slice: bundle-index-broken-links)
//
// Internal markdown links whose resolved target does NOT exist in the Bundle
// index render with a distinct `cm-broken-link` class (dashed/red — see the CSS
// below). The check is SYNCHRONOUS: it consults a caller-provided predicate
// (backed by the frontend index store's cached path set) while walking the
// syntax tree, because CodeMirror decorations cannot await IPC.
//
// Links remain fully clickable and navigable — this is styling only, never a
// block (broken links are tolerated per the OKF spec, docs/GLOSSARY.md).
//
// Freshness: the decoration re-runs on doc changes AND when the host dispatches
// `refreshBrokenLinks` (fired on the `file-changed` watcher event and on
// Concept switch, so created/removed targets restyle without a reload).
// ---------------------------------------------------------------------------

/** Context the decoration needs: which Concept is open (resolution base). The
 *  existence check + bundle-root now live on the wasm handle (`indexStore`). */
export interface BrokenLinkContext {
  /** bundle-relative path of the open Concept (for relative-link resolution). */
  currentPath: () => string;
}

/** Dispatch this effect to force the broken-link decoration to recompute. */
export const refreshBrokenLinks = StateEffect.define<null>();

const brokenLinkMark = Decoration.mark({ class: 'cm-broken-link' });

/** Distinct styling for broken internal links: dashed, red. Clickable still. */
export const brokenLinkTheme = EditorView.theme({
  '.cm-broken-link': {
    color: 'var(--danger)',
    textDecoration: 'underline dashed var(--danger)',
    textUnderlineOffset: '2px',
  },
});

/**
 * Build the broken-link decoration set for the current viewport: walk the
 * syntax tree, find `Link` nodes, extract their URL, resolve it the same way
 * the navigation seam does (`resolveLink`), and mark the link's text range
 * broken when it resolves to an internal target absent from the index.
 */
function computeBrokenLinks(view: EditorView, ctx: BrokenLinkContext): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const currentPath = ctx.currentPath();

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== 'Link') return;
        // A markdown Link node spans `[text](url)`. Find the `URL` child for the
        // href, and mark the whole link range so the styling covers the text.
        let href: string | null = null;
        const cursor = node.node.cursor();
        if (cursor.firstChild()) {
          do {
            if (cursor.name === 'URL') {
              href = view.state.sliceDoc(cursor.from, cursor.to);
              break;
            }
          } while (cursor.nextSibling());
        }
        if (href === null) return;
        // Resolve synchronously through the wasm handle; the `internal` variant
        // carries `exists`, so a broken internal link is `!resolved.exists`.
        const resolved = indexStore.resolveLink(currentPath, href);
        if (resolved.kind === 'internal' && !resolved.exists) {
          builder.add(node.from, node.to, brokenLinkMark);
        }
      },
    });
  }
  return builder.finish();
}

/**
 * The broken-link extension: a ViewPlugin recomputing the decoration on doc /
 * viewport changes and on an explicit `refreshBrokenLinks` effect.
 */
export function brokenLinks(ctx: BrokenLinkContext): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = computeBrokenLinks(view, ctx);
      }
      update(update: ViewUpdate) {
        const refreshed = update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(refreshBrokenLinks)),
        );
        if (update.docChanged || update.viewportChanged || refreshed) {
          this.decorations = computeBrokenLinks(update.view, ctx);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/**
 * Force the broken-link decoration to recompute (e.g. after the Bundle index's
 * existing-path set changed on a `file-changed` event, or after switching
 * Concepts). Cheap no-op dispatch carrying the `refreshBrokenLinks` effect.
 */
export function refreshBrokenLinkDecorations(view: EditorView): void {
  view.dispatch({ effects: refreshBrokenLinks.of(null) });
}
