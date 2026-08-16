import { StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
// `treeGrowthEffect`/`treeProgressPlugin` are re-exported from the package root
// via our patch (see patches/@atomic-editor%2Feditor@0.4.3.patch) — the package
// does not expose its `./tree-progress` subpath. We listen for the effect and
// include the plugin so fences parsed after the initial budgeted parse (long
// documents) still render, matching `imageBlocks`/`tables`.
import { treeGrowthEffect, treeProgressPlugin } from '@atomic-editor/editor';
import {
  findMermaidBlocks,
  hasMermaidBlock,
  selectionTouches,
  type MermaidBlock,
  type ResolvedTheme,
} from './mermaidBlocks';
import { renderDiagram } from './mermaidRender';

// ---------------------------------------------------------------------------
// Mermaid block rendering (slice: mermaid-block-render, ADR-0005)
//
// Our OWN CodeMirror StateField, built ALONGSIDE atomic-editor's
// `imageBlocks`/`tables` (atomic-editor exposes no generic block-renderer seam,
// so this is a parallel, purpose-built field). It walks the syntax tree for
// `FencedCode` nodes whose info is `mermaid` (detection lives in the pure
// `mermaidBlocks.ts`), and replaces each whole fence with the rendered Diagram
// via `Decoration.replace({ block: true })`:
//
//   - cursor OUTSIDE the fence (hybrid)  -> diagram shown
//   - cursor INSIDE the fence  (hybrid)  -> replace lifted, raw fence revealed
//   - `view` mode                        -> always rendered (no reveal)
//   - `edit` mode                        -> this field is NOT in the extension
//                                           set at all, so the raw fence shows
//
// The render engine itself (lazy `import('mermaid')` gated on the doc actually
// containing a block, `securityLevel: 'strict'`, muted loading placeholder,
// bordered error panel on a failed render, app-palette theming via
// `mermaidThemeConfig`, `(source, theme) → SVG` cache, per-host generation
// token) is the SHARED `mermaidRender.ts` — also used by the web viewer's
// island. This module is the CodeMirror side only: the StateField, the block
// widget (with its hybrid edit-affordance), and the `cm-mermaid-*` styling.
//
// Theme-sync (ADR-0005): diagrams bake the app's palette/font into the SVG at
// render time, so on a light/dark flip `App.svelte` calls
// `setEditorMermaidTheme`, which RECONFIGURES the mode Compartment (cm.ts) —
// rebuilding this field so every diagram re-renders. (A StateEffect was
// insufficient: CodeMirror does not reconcile block-widget DOM for an in-place
// decoration change.)
// ---------------------------------------------------------------------------

/**
 * Render `source` into `host` via the shared engine, resolving the app
 * palette/font from the THEMED editor root (`view.dom` already carries the
 * current `data-theme` — App.svelte sets it before dispatching the theme flip,
 * so `getComputedStyle` yields the active light/dark token values).
 */
function renderInto(
  host: HTMLElement,
  source: string,
  theme: ResolvedTheme,
  view: EditorView,
): void {
  const cs = getComputedStyle(view.dom);
  void renderDiagram(host, source, theme, {
    classPrefix: 'cm-mermaid',
    read: (name) => cs.getPropertyValue(name).trim(),
  });
}

/**
 * The block widget that replaces a mermaid fence with its rendered Diagram.
 * Thin over `renderInto`; keyed on `(source + theme)` for DOM reuse across
 * unrelated edits, while still re-rendering on a theme flip.
 *
 * `reading` (view mode) is carried so the edit-affordance is added ONLY in
 * hybrid — view is read-only and never lifts the block-replace, so a "click to
 * edit" hint there would be a lie. It is part of `eq()`: a live mode toggle
 * reconfigures the mode Compartment IN PLACE (no view rebuild), so a stale
 * hybrid widget (same source + theme) would otherwise be reused in view mode and
 * keep its now-lying edit affordance.
 */
class MermaidWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly theme: ResolvedTheme,
    readonly reading: boolean,
  ) {
    super();
  }

  // Reuse DOM (skip re-render) when the diagram source, the resolved theme AND
  // the reading flag are unchanged. Including the theme means a theme flip
  // produces a non-equal widget, so CM6 re-renders in the new colours; including
  // `reading` means a hybrid↔view mode toggle (an in-place Compartment
  // reconfigure, not a rebuild) rebuilds the DOM so the edit affordance is added
  // in hybrid and dropped in read mode. An edit elsewhere (same source + theme +
  // reading) reuses the existing SVG (ADR-0005).
  eq(other: MermaidWidget): boolean {
    return (
      other.source === this.source &&
      other.theme === this.theme &&
      other.reading === this.reading
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-mermaid';

    // The rendered SVG / placeholder / error panel lives in an inner element so
    // `renderInto`'s `innerHTML` swap never wipes the edit-affordance siblings
    // (the hover hint) appended to `wrap`.
    const render = document.createElement('div');
    render.className = 'cm-mermaid-render';
    wrap.appendChild(render);
    renderInto(render, this.source, this.theme, view);

    // Edit-affordance (ADR-0005, options 6a+6b): a `block: true` replace has no
    // source text to click into, so add a discoverable way to start editing —
    // hybrid only (view is read-only, never lifts the replace).
    if (!this.reading) {
      wrap.classList.add('cm-mermaid-editable');
      wrap.title = 'Click to edit diagram';

      // A subtle "click to edit" hint shown on hover (CSS reveals it).
      const hint = document.createElement('span');
      hint.className = 'cm-mermaid-edit-hint';
      hint.setAttribute('aria-hidden', 'true');
      hint.textContent = '✎ edit';
      wrap.appendChild(hint);

      // Double-click lifts the block-replace by dropping the cursor INTO the
      // fence. We resolve the fence position from the widget's CURRENT DOM
      // location (`posAtDOM`) rather than a captured offset, so it stays correct
      // even when CM6 reuses this DOM after an unrelated edit shifted the range.
      wrap.addEventListener('dblclick', (event) => {
        event.preventDefault();
        const pos = view.posAtDOM(wrap);
        // +1 nudges past the fence start so the selection sits strictly inside
        // the fence (selectionTouches treats edges as inside, but a hair inside
        // is unambiguous), reliably lifting the replace and revealing raw source.
        const target = Math.min(pos + 1, view.state.doc.length);
        view.dispatch({ selection: { anchor: target } });
        view.focus();
      });
    }

    return wrap;
  }

  // Let our own `dblclick` handler (added in `toDOM`) own double-clicks so CM6
  // does not also try to map the event to a text position under the widget
  // (there is none — the source is replaced). Other pointer events fall through
  // to CM6 so a single click near the diagram can still move the caret.
  ignoreEvent(event: Event): boolean {
    return event.type === 'dblclick';
  }
}

/**
 * Build the replace-decoration set for the current state. In `view` mode every
 * mermaid fence is replaced (always rendered). In `hybrid` a fence the
 * selection touches is LEFT as raw source (the replace is lifted) so it can be
 * edited; all others are replaced with the diagram.
 */
function buildDecorations(
  state: Parameters<typeof findMermaidBlocks>[0],
  reading: boolean,
  theme: ResolvedTheme,
): DecorationSet {
  const blocks: MermaidBlock[] = findMermaidBlocks(state);
  const ranges = [];
  for (const block of blocks) {
    // Hybrid: reveal the raw fence when the cursor is inside it.
    if (!reading && selectionTouches(state, block.from, block.to)) continue;
    ranges.push(
      Decoration.replace({
        widget: new MermaidWidget(block.source, theme, reading),
        block: true,
      }).range(block.from, block.to),
    );
  }
  return Decoration.set(ranges, true);
}

/**
 * The mermaid StateField. Rebuilds:
 *   - on `treeGrowthEffect`, so fences parsed after the initial budgeted parse
 *     (long documents) still render — same contract as `imageBlocks`/`tables`;
 *   - on doc change (a fence may have been added/removed/edited);
 *   - on selection change (hybrid reveal: cursor entering/leaving a fence).
 *
 * Both `reading` and `theme` are FIXED when the field is constructed. The field
 * lives in the mode Compartment (`cm.ts`), which is reconfigured — rebuilding
 * the field — both on a mode switch AND on a light/dark flip (`setEditorMode` /
 * `setEditorMermaidTheme`). A compartment reconfigure forces a full re-render of
 * every diagram (CodeMirror does NOT reconcile block-widget DOM for an in-place
 * decoration change, so a pure StateEffect would leave baked SVGs stale — see
 * ADR-0005, theme-sync). So a flip rebuilds the field with the new `theme`,
 * which threads into each widget's `(source, theme)` key and the baked colours.
 */
function mermaidField(reading: boolean, theme: ResolvedTheme): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create: (state) => buildDecorations(state, reading, theme),
    update(deco, tr) {
      for (const effect of tr.effects) {
        if (effect.is(treeGrowthEffect)) {
          return buildDecorations(tr.state, reading, theme);
        }
      }
      if (tr.docChanged || tr.selection) {
        return buildDecorations(tr.state, reading, theme);
      }
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

/** Muted loading placeholder + diagram container styling. */
const mermaidTheme = EditorView.theme({
  '.cm-mermaid': {
    position: 'relative',
    padding: '0.5rem 0',
  },
  // The inner render target (SVG / placeholder / error panel). Centres the
  // diagram; siblings (the edit hint) sit on the outer `.cm-mermaid`.
  '.cm-mermaid-render': {
    display: 'flex',
    justifyContent: 'center',
  },
  '.cm-mermaid svg': {
    maxWidth: '100%',
    height: 'auto',
  },
  // Belt-and-suspenders: mermaid sets fonts inline from `fontFamily`, but force
  // the app UI font across all diagram text (incl. htmlLabel spans) so a Diagram
  // never falls back to mermaid's default sans (ADR-0005, theme-sync).
  '.cm-mermaid svg, .cm-mermaid svg text, .cm-mermaid svg .nodeLabel, .cm-mermaid svg .edgeLabel, .cm-mermaid svg span':
    {
      fontFamily: 'var(--font-ui) !important',
    },
  // Edit-affordance (edit-affordance slice): a rendered diagram in hybrid is
  // double-clickable to reveal its raw source, so signal that with a pointer
  // cursor and a subtle hover hint. Positioned relative so the hint can anchor.
  '.cm-mermaid-editable': {
    position: 'relative',
    cursor: 'pointer',
  },
  '.cm-mermaid-edit-hint': {
    position: 'absolute',
    top: '0.35rem',
    right: '0.35rem',
    padding: '0.1rem 0.4rem',
    borderRadius: 'var(--radius-pill, 999px)',
    background: 'var(--accent, #4060d0)',
    color: 'var(--accent-contrast, #fff)',
    fontSize: '0.72em',
    fontWeight: '600',
    lineHeight: '1.4',
    pointerEvents: 'none',
    opacity: '0',
    transition: 'opacity 0.12s ease',
  },
  '.cm-mermaid-editable:hover .cm-mermaid-edit-hint': {
    opacity: '1',
  },
  '.cm-mermaid-loading': {
    color: 'var(--text-muted, #888)',
    fontStyle: 'italic',
    fontSize: '0.9em',
    padding: '0.5rem 0',
  },
  // A failed render: a bordered panel (mermaid's message + the raw source
  // beneath) — deliberately distinct from a plain fenced code block so a broken
  // diagram reads as broken, not as un-highlighted code (error-state slice).
  '.cm-mermaid-error': {
    width: '100%',
    border: '1px solid var(--danger, #d33)',
    borderRadius: 'var(--radius-sm, 4px)',
    background: 'var(--danger-soft, rgba(221, 51, 51, 0.08))',
    padding: '0.6rem 0.75rem',
    boxSizing: 'border-box',
    textAlign: 'left',
  },
  '.cm-mermaid-error-heading': {
    color: 'var(--danger, #d33)',
    fontWeight: '600',
    fontSize: '0.85em',
    marginBottom: '0.35rem',
  },
  '.cm-mermaid-error-message': {
    color: 'var(--danger, #d33)',
    fontSize: '0.85em',
    whiteSpace: 'pre-wrap',
    marginBottom: '0.5rem',
  },
  '.cm-mermaid-error-source': {
    margin: '0',
    padding: '0.5rem',
    borderRadius: 'var(--radius-sm, 4px)',
    background: 'var(--bg-sunken, rgba(0, 0, 0, 0.06))',
    color: 'var(--text, inherit)',
    fontFamily: 'var(--font-mono, monospace)',
    fontSize: '0.85em',
    whiteSpace: 'pre-wrap',
    overflowX: 'auto',
  },
});

// Re-export so cm.ts can gate work on whether the doc has any diagram (kept
// here so the editor builder imports a single mermaid surface).
export { hasMermaidBlock };

/**
 * The mermaid block-render extension. Wire into `modeExtensions` for `hybrid`
 * and `view` ONLY (NOT `edit` — source mode shows the raw fence). `reading` is
 * true for `view` (always rendered), false for `hybrid` (cursor reveals raw).
 *
 * `theme` is the resolved app scheme to render diagrams in. It is baked into the
 * field at construction; a light/dark flip reconfigures the mode Compartment
 * (`setEditorMermaidTheme`), rebuilding this extension with the new theme so
 * every diagram re-renders (ADR-0005, theme-sync).
 *
 * Includes `treeProgressPlugin` so the field's `treeGrowthEffect` rebuild
 * actually fires on long documents (the plugin is idempotent across the other
 * block fields that also include it — CM6 dedups identical extensions).
 */
export function mermaidBlocks(reading: boolean, theme: ResolvedTheme): Extension {
  return [mermaidField(reading, theme), mermaidTheme, treeProgressPlugin];
}
