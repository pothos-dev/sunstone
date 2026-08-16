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
  mermaidCacheKey,
  mermaidThemeConfig,
  selectionTouches,
  type MermaidBlock,
  type ResolvedTheme,
} from './mermaidBlocks';

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
// `mermaid` is LAZY-loaded via dynamic `import('mermaid')`, gated on the doc
// actually containing a mermaid block, and initialised with
// `securityLevel: 'strict'`. While the module imports / a diagram renders, a
// muted placeholder is shown.
//
// SEAMS LEFT FOR SIBLING SLICES (deliberately NOT built here):
//   - error-state:   DONE (error-state slice). A failed `mermaid.render()` now
//                    paints a bordered error panel (mermaid's message + raw
//                    source) via `buildErrorPanel`, distinct from a code block.
//   - theme-sync:    DONE (theme-sync slice). Diagrams are themed with the app's
//                    OWN palette + font (`mermaidThemeConfig` → mermaid's `base`
//                    theme with `themeVariables` resolved from CSS custom props
//                    on the editor root), not mermaid's generic dark/default. On
//                    a light/dark flip `App.svelte` calls `setEditorMermaidTheme`,
//                    which RECONFIGURES the mode Compartment (cm.ts) — rebuilding
//                    this field so every diagram re-renders. (A StateEffect was
//                    insufficient: CodeMirror does not reconcile block-widget DOM
//                    for an in-place decoration change.)
//   - edit-affordance: DONE (edit-affordance slice). In hybrid the widget shows
//                    a hover hint (cursor:pointer + "✎ edit") and a double-click
//                    handler dispatches a selection INTO the fence to lift the
//                    block-replace. The global `edit` toggle stays the fallback.
//   - render-caching: DONE (render-caching slice). `WidgetType.eq()` is keyed on
//                    `(source + theme)` (DOM reuse across unrelated edits); a
//                    module-level `(source,theme)->SVG` cache paints identical
//                    diagrams instantly; a per-host generation token discards a
//                    stale in-flight render that resolves after a newer one.
// ---------------------------------------------------------------------------

/**
 * Lazily-resolved mermaid module + one-time `initialize`. The dynamic import is
 * only triggered when a document actually contains a mermaid block (the field's
 * builder calls `ensureMermaid()` only then), so diagram-free Concepts never
 * pull mermaid's large bundle. Cached as a promise so concurrent widgets share
 * one import.
 */
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

function ensureMermaid(): Promise<typeof import('mermaid').default> {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = import('mermaid').then((mod) => {
    const mermaid = mod.default;
    mermaid.initialize({
      // No auto-scan; we render each diagram explicitly via `render`.
      startOnLoad: false,
      // OKF bundles are shareable, so a diagram's source may be untrusted —
      // strict sanitisation (no click callbacks, no raw HTML labels) is the
      // safe default (ADR-0005). Interactivity is a later concern.
      securityLevel: 'strict',
      // Stop mermaid from injecting its OWN error graph into the DOM on a
      // parse failure — we render our own in-place error panel.
      suppressErrorRendering: true,
    });
    return mermaid;
  });
  return mermaidPromise;
}

/** Monotonic id source for unique mermaid render ids (mermaid requires one). */
let renderSeq = 0;

/**
 * Module-level `(source, theme) → SVG` cache (render-caching slice, ADR-0005
 * option 9a). The field rebuilds its decoration set on every doc change — even
 * edits BETWEEN diagrams — and `mermaid.render()` is async, so an identical
 * diagram (or one edited back to a prior state) should paint instantly from
 * memory rather than re-running mermaid. Keyed by `mermaidCacheKey` so the key
 * matches `WidgetType.eq()`: same `(source + theme)` → same SVG.
 */
const svgCache = new Map<string, string>();

/**
 * Build the error-state panel for a failed `mermaid.render()` (error-state
 * slice, ADR-0005 option 4a). A bordered panel surfaces mermaid's error
 * message, with the raw fence source rendered beneath it, so the user sees both
 * what is broken and what they typed without dropping into `edit` mode. The
 * `.cm-mermaid-error` class makes a broken diagram visibly distinct from a plain
 * code block (which has no renderer). DOM-only and pure; no async.
 */
function buildErrorPanel(message: string, source: string): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'cm-mermaid-error';

  const heading = document.createElement('div');
  heading.className = 'cm-mermaid-error-heading';
  heading.textContent = 'Diagram error';
  panel.appendChild(heading);

  const msg = document.createElement('div');
  msg.className = 'cm-mermaid-error-message';
  // mermaid's message is plain text; set as textContent (never innerHTML) so a
  // malicious diagram source can't smuggle markup through the error path.
  msg.textContent = message;
  panel.appendChild(msg);

  const raw = document.createElement('pre');
  raw.className = 'cm-mermaid-error-source';
  raw.textContent = source;
  panel.appendChild(raw);

  return panel;
}

/**
 * Render `source` into `host` as an SVG diagram in the given resolved app
 * `theme`. Shows a muted placeholder immediately, lazy-loads mermaid, applies
 * the theme via `initialize({ theme })`, then swaps in the SVG. On a
 * render/parse failure it replaces the placeholder with a bordered error panel
 * (mermaid's message + the raw source) — error-state slice (ADR-0005). The error
 * clears automatically when the source is fixed: the field rebuilds and
 * re-renders.
 *
 * A baked SVG cannot recolour via CSS inheritance (theme-sync, ADR-0005), so the
 * theme is applied at render time and the field rebuilds (re-rendering) on a
 * theme flip. Async and self-contained so the caching/generation-token slice can
 * wrap it without reshaping the widget.
 */
/**
 * Per-host generation token (render-caching slice). Each `renderInto` call bumps
 * the host's generation; an async render only paints if its captured generation
 * is still the host's current one. So if CM6 reuses a host DOM and a NEWER
 * render is kicked off (e.g. a fast source-change-then-revert), the older
 * in-flight render — resolving later — is discarded rather than swapped in over
 * the newer result (no stale SVG ever displayed). Keyed by the host element via
 * a WeakMap so it is GC'd with the DOM.
 */
const hostGeneration = new WeakMap<HTMLElement, number>();

function renderInto(
  host: HTMLElement,
  source: string,
  theme: ResolvedTheme,
  view: EditorView,
): void {
  // Claim a fresh generation for this render; any earlier in-flight render for
  // this host is now stale and must not paint.
  const generation = (hostGeneration.get(host) ?? 0) + 1;
  hostGeneration.set(host, generation);
  const current = () => hostGeneration.get(host) === generation;

  const key = mermaidCacheKey(source, theme);

  // Cache hit: an identical diagram (same source + theme) was rendered before —
  // paint synchronously from memory, no fresh `mermaid.render()`.
  const cached = svgCache.get(key);
  if (cached !== undefined) {
    host.innerHTML = cached;
    return;
  }

  // Resolve the app palette/font from the THEMED editor root NOW (synchronously,
  // before the async render). `view.dom` already carries the current `data-theme`
  // (App.svelte sets it before dispatching the theme flip), so `getComputedStyle`
  // yields the active light/dark token values. Concrete values are required —
  // mermaid bakes colours into the SVG at render time (ADR-0005, theme-sync).
  const cs = getComputedStyle(view.dom);
  const themeConfig = mermaidThemeConfig((name) => cs.getPropertyValue(name).trim(), theme);

  const placeholder = document.createElement('div');
  placeholder.className = 'cm-mermaid-loading';
  placeholder.textContent = 'Rendering diagram…';
  host.innerHTML = '';
  host.appendChild(placeholder);

  const id = `cm-mermaid-${renderSeq++}`;
  ensureMermaid()
    .then((mermaid) => {
      // Theme the diagram with the app's own palette + font (mermaid's `base`
      // theme with our `themeVariables`), not mermaid's generic dark/default.
      // mermaid bakes colours in at `render` time, so re-`initialize` per render
      // keeps the diagram in step with the app's light/dark scheme (option 5a).
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        ...themeConfig,
      });
      return mermaid.render(id, source);
    })
    .then(({ svg }) => {
      // Cache the successful render for instant repaint of identical diagrams.
      svgCache.set(key, svg);
      // Discard a stale render: only paint if THIS render is still the newest
      // for the host (generation unchanged) and the host is still mounted.
      if (!host.isConnected || !current()) return;
      host.innerHTML = svg;
    })
    .catch((err: unknown) => {
      // Surface the failure as a bordered error panel (raw source beneath the
      // message) rather than swallowing it — a half-typed diagram is invalid
      // most of the time the cursor sits just outside it (ADR-0005, 4a).
      // Errors are NOT cached: fixing the source must re-attempt the render.
      // Belt-and-suspenders: remove any temporary render element mermaid may
      // have left appended to the document on failure (in addition to
      // `suppressErrorRendering`), so no orphan diagram lingers in the page.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
      if (!host.isConnected || !current()) return;
      const message = err instanceof Error ? err.message : String(err);
      host.innerHTML = '';
      host.appendChild(buildErrorPanel(message, source));
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
