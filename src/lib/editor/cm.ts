import { EditorView } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { serializeFrontmatter, type Property } from '$lib/frontmatter';
import { minimalChange } from '$lib/minimalChange';

import { setFrontmatter, frontmatterField } from './frontmatter-field';
import type { ResolvedTheme } from './mermaidBlocks';
import { wikiLinksExtension } from './wiki-links';
import {
  programmatic,
  defaultLinkClick,
  editorExtensions,
  modeExtensions,
  DEFAULT_EDITOR_MODE,
  type BuildEditorOptions,
  type EditorMode,
} from './extensions';
import {
  initViewSession,
  getViewOptions,
  getViewPath,
  setViewPath,
  getWikiCompartment,
  ensureWikiCompartment,
  getLivePreviewCompartment,
  ensureLivePreviewCompartment,
  getViewMode,
  setViewMode,
  getViewMermaidTheme,
  setViewMermaidTheme,
} from './viewState';

// The editor's public surface is re-exported here so consumers keep importing
// from `$lib/editor/cm`. The frontmatter/broken-link/find concerns now live in
// sibling modules; cm.ts is the editor BUILDER that assembles them.
export {
  setFrontmatter,
  frontmatterField,
  dispatchFrontmatter,
} from './frontmatter-field';
export {
  refreshBrokenLinks,
  refreshBrokenLinkDecorations,
  type BrokenLinkContext,
} from './broken-links';
export { type WikiLinkContext } from './wiki-links';
export { type CommentEditRequest, type OnCommentEdit } from './criticMarkupView';
export {
  anchorTracking,
  pendingAnchorRenames,
  commitAnchorBaseline,
} from './anchor-tracking';
export { openSearch } from './find';
export {
  annotateActionFor,
  selectionForAnnotate,
  annotate,
  addAnnotationWithComment,
  updateAnnotationComment,
  removeAnnotationAt,
  toggleBold,
  toggleItalic,
  toggleStrikethrough,
  toggleInlineCode,
  linkActionFor,
  insertOrEditLink,
  copySelection,
  cutSelection,
  pasteFromClipboard,
} from './commands';
// The extension assembly (extension list, mode slice, keymaps, listeners) lives
// in `extensions.ts`; the scroll/viewport probes in `scroll.ts`. Both stay part
// of the `$lib/editor/cm` surface.
export { DEFAULT_EDITOR_MODE, type EditorMode, type BuildEditorOptions } from './extensions';
export { lineAtViewportTop, scrollToLine } from './scroll';

/**
 * Builds the CodeMirror 6 EditorView with the atomic-editor live-preview
 * extension set (ADR 0001): Obsidian-style hybrid preview where the markdown
 * source is the on-disk truth, inactive lines render styled, and the cursor
 * line shows raw markup.
 *
 * Editable (slice editing-autosave-watcher); was read-only in slice 1.
 *
 * The GFM parser (`markdown({ base: markdownLanguage, codeLanguages })`) is the
 * keystone: without `base: markdownLanguage` the parser is pure CommonMark and
 * inline-preview never sees Task / Table nodes; without `codeLanguages` fenced
 * blocks have no grammar to highlight with. The grammars load lazily (see the
 * `ATOMIC_CODE_LANGUAGES` import note).
 *
 * Wikilinks (`[[name]]`) are supported as an OPTIONAL, name-based SECONDARY
 * link format alongside primary markdown links (ADR-0004) — Sunstone bundles
 * often originate as Obsidian vaults. We enable atomic-editor's `wikiLinks`
 * extension (wrapped in a `Compartment` for cache invalidation) with a Sunstone
 * resolve/onOpen adapter; see `wiki-links.ts`. (ADR-0001's "we do not use
 * wikiLinks" is scoped to OKF's own format — this is the deliberate exception.)
 *
 * Theme: the editor root's `data-theme` mirrors the app root's, which is owned
 * by the theme store (`state/theme.svelte.ts`, OS-driven default). We seed it at
 * build time from the inherited `data-theme` and the app shell keeps it in sync.
 *
 * Autosave hooks: `onChange` fires on every user edit (the editor store
 * debounces it); `onBlur` fires when focus leaves the editor (flush save).
 */

/**
 * Resolve the theme to seed the editor root with at build time, by reading the
 * `data-theme` set on the nearest ancestor (the app root — owned by the theme
 * store, see `state/theme.svelte.ts`). The app shell keeps this attribute in
 * sync afterwards via an `$effect`; this just avoids a flash of the wrong theme
 * on the very first build. Falls back to the OS preference if no ancestor has
 * set it yet.
 */
function inheritedTheme(parent: HTMLElement): 'light' | 'dark' {
  const fromDom = parent.closest('[data-theme]')?.getAttribute('data-theme');
  if (fromDom === 'light' || fromDom === 'dark') return fromDom;
  const prefersDark =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'dark' : 'light';
}

/**
 * Per-view session state (build options, Concept path, the wikilink/mode
 * Compartments, the current mode, and the mermaid theme) lives in `viewState.ts`
 * as one record per `EditorView`, keyed there rather than via five separate
 * WeakMaps here — see `initViewSession` and its `getView*`/`setView*` accessors.
 */

/**
 * Build a READ-ONLY review buffer (review-toggle: working-tree ↔ HEAD).
 *
 * `reviewText` is the in-memory CriticMarkup diff (ticket 03's `diffToCriticMarkup`
 * of `HEAD` vs the working tree). It is rendered in reading (`read`) mode so
 * ticket 01's add/del marks show WITHOUT any cursor-reveal of raw markup, and
 * the buffer is read-only. Crucially it is wired with NO `onChange`/`onBlur`, so
 * the review text can NEVER reach `editor.edit` / autosave — it lives only in
 * this view and is discarded when the view is destroyed on exit. Pre-existing
 * highlight/comment annotations in the text still render (they are the same
 * CriticMarkup decorations).
 */
export function buildReviewEditor(parent: HTMLElement, reviewText: string): EditorView {
  return buildEditor({
    parent,
    doc: reviewText,
    frontmatter: [],
    // No `path` and no `onChange`/`onBlur`: this buffer is in-memory only and
    // must never autosave. `read` mode = read-only + marks visible + no reveal.
    path: null,
    initialMode: 'read',
  });
}

/**
 * Replace a review buffer's document with a new CriticMarkup diff (history
 * stepper: re-render on each step, issue 05) WITHOUT rebuilding the view.
 *
 * The review buffer is read-only, but a PROGRAMMATIC dispatch still applies
 * (`EditorState.readOnly` only blocks user input, not `view.dispatch`), and —
 * built with no `onChange`/`onBlur` wiring — it can never autosave. Reuses
 * `setEditorConcept`'s in-place branch: the review buffer's path stays `null`,
 * so this never triggers a state rebuild, and the empty frontmatter is a no-op.
 */
export function setReviewText(view: EditorView, reviewText: string): void {
  setEditorConcept(view, reviewText, [], null);
}

export function buildEditor(options: BuildEditorOptions): EditorView {
  const { parent, doc, frontmatter = [] } = options;
  const wikiCompartment = new Compartment();
  const livePreviewCompartment = new Compartment();
  const mode = options.initialMode ?? DEFAULT_EDITOR_MODE;
  // Seed diagrams with the theme inherited from the app root, so the first paint
  // matches the app scheme without waiting for the host's theme effect.
  const theme = inheritedTheme(parent);
  const state = EditorState.create({
    doc,
    extensions: [
      // Seed the frontmatter field with the open Concept's properties.
      frontmatterField.init(() => frontmatter),
      ...editorExtensions(options, wikiCompartment, livePreviewCompartment, mode, theme),
    ],
  });

  const view = new EditorView({ state, parent });
  initViewSession(view, options, wikiCompartment, livePreviewCompartment, mode, theme);

  // Seed the editor root's theme from the app root (the theme store keeps it in
  // sync afterwards). atomic-editor reads `data-theme` on the CodeMirror root.
  view.dom.setAttribute('data-theme', theme);

  return view;
}

/**
 * Replace an existing view's body + frontmatter (switching Concepts, or
 * reloading after an external change).
 *
 * Unified-undo (this slice): history must NOT cross Concept boundaries. When the
 * `path` differs from what the view last showed, we REBUILD the EditorState from
 * scratch (`view.setState`) with the new body, a freshly-seeded frontmatter
 * field, and a brand-new `history()` — so undo can never reach back into the
 * previously-open Concept. The rebuild reuses the same shared `editorExtensions`
 * (so listeners keep working) and seeds the field directly (NOT via a
 * `setFrontmatter` effect), which also means the rebuild fires no autosave: a
 * fresh state with no user transaction produces no `onChange` call.
 *
 * When the path is UNCHANGED (external reload of the open Concept, or a body
 * self-edit reflow), we keep the in-place dispatch path: each half updates only
 * when it actually changed (no pointless transactions / cursor disruption), and
 * the dispatch is marked `programmatic` so it is NOT autosaved back. Editing the
 * SAME doc therefore keeps coalescing in the existing history as before.
 */
export function setEditorConcept(
  view: EditorView,
  body: string,
  props: Property[],
  path: string | null = null,
): void {
  const prevPath = getViewPath(view);
  const switched = path !== prevPath;
  setViewPath(view, path);

  if (switched) {
    // Fresh state = fresh history. No history can survive the Concept boundary.
    const options = getViewOptions(view);
    // Reuse the view's existing Compartment instance so `reconfigureWikiLinks`
    // keeps targeting it after the switch. The fresh state re-evaluates the
    // compartment, so the wikilink cache also starts clean for the new Concept.
    const wikiCompartment = ensureWikiCompartment(view);
    // Likewise reuse the mode Compartment and carry the current mode across the
    // switch, so the new Concept opens in the same editing/read mode.
    const livePreviewCompartment = ensureLivePreviewCompartment(view);
    const mode = getViewMode(view) ?? DEFAULT_EDITOR_MODE;
    const theme = getViewMermaidTheme(view) ?? 'light';
    view.setState(
      EditorState.create({
        doc: body,
        extensions: [
          frontmatterField.init(() => props),
          ...(options
            ? editorExtensions(options, wikiCompartment, livePreviewCompartment, mode, theme)
            : []),
        ],
      }),
    );
    // Mirror the new frontmatter out: a state rebuild fires no update listener,
    // so push it to the Properties panel explicitly. History was reset to empty,
    // so refresh the host's undo/redo state too.
    options?.onFrontmatterChange?.(props);
    options?.onHistory?.();
    return;
  }

  const current = view.state.doc.toString();
  const docChanged = current !== body;
  const fmChanged =
    serializeFrontmatter(view.state.field(frontmatterField)) !== serializeFrontmatter(props);
  if (!docChanged && !fmChanged) return;
  // Apply a MINIMAL change (common prefix/suffix trimmed) rather than a whole-doc
  // replace, so CodeMirror maps the selection/cursor through it. This matters for
  // multi-tile sync: when a SECOND tile shows the same Concept, an edit in the
  // first tile pushes new content here — a minimal change keeps the untouched
  // tile's caret in place instead of collapsing it to the doc end.
  // `minimalChange` returns `null` when the strings are equal; `docChanged` already
  // guards that case, so the change is only omitted when there's no doc edit at all.
  view.dispatch({
    changes: docChanged ? (minimalChange(current, body) ?? undefined) : undefined,
    effects: fmChanged ? [setFrontmatter.of(props)] : [],
    annotations: programmatic.of(true),
  });
}

/**
 * Reconfigure the view's wikilink Compartment to clear the `wikiLinks`
 * extension's resolve-cache and re-resolve visible links. Hook this to the SAME
 * index signal that refreshes broken markdown links (the index's path set
 * changed → resolutions may now differ). No-op when the view has no wikilink
 * context. Recreating the extension recreates its StateField → fresh cache.
 */
export function reconfigureWikiLinks(view: EditorView): void {
  const compartment = getWikiCompartment(view);
  const ctx = getViewOptions(view)?.wikiLinkContext;
  if (!compartment || !ctx) return;
  view.dispatch({ effects: compartment.reconfigure(wikiLinksExtension(ctx)) });
}

/**
 * Tell the editor which resolved app theme to render diagrams in (theme-sync,
 * ADR-0005). A baked diagram SVG lives outside Svelte reactivity AND CodeMirror
 * does NOT reconcile block-widget DOM for an in-place decoration change, so a
 * StateEffect would leave existing diagrams stale. Instead we RECONFIGURE the
 * mode Compartment with the new theme — a full rebuild of the mode slice that
 * re-runs every diagram's `toDOM`, re-rendering it in the new scheme. App.svelte
 * calls this from the `$effect` mirroring `theme.resolved`. No-op when the theme
 * is unchanged or before the compartment exists.
 */
export function setEditorMermaidTheme(view: EditorView, resolved: ResolvedTheme): void {
  const compartment = getLivePreviewCompartment(view);
  if (!compartment || getViewMermaidTheme(view) === resolved) return;
  setViewMermaidTheme(view, resolved);
  const mode = getEditorMode(view);
  const onLinkClick = getViewOptions(view)?.onLinkClick ?? defaultLinkClick;
  const onCommentEdit = getViewOptions(view)?.onCommentEdit;
  view.dispatch({
    effects: compartment.reconfigure(modeExtensions(mode, onLinkClick, resolved, onCommentEdit)),
  });
}

/** The view's current mode (`read` if the view predates mode tracking). */
function getEditorMode(view: EditorView): EditorMode {
  return getViewMode(view) ?? DEFAULT_EDITOR_MODE;
}

/**
 * Switch the view between `editing` / `read` by reconfiguring the mode
 * Compartment — no view rebuild, so the document, history and selection are
 * preserved. The mode is remembered (view session) so it carries across Concept
 * switches. No-op if the mode is unchanged or the view has no compartment.
 */
export function setEditorMode(view: EditorView, mode: EditorMode): void {
  const compartment = getLivePreviewCompartment(view);
  if (!compartment || getEditorMode(view) === mode) return;
  setViewMode(view, mode);
  const onLinkClick = getViewOptions(view)?.onLinkClick ?? defaultLinkClick;
  const onCommentEdit = getViewOptions(view)?.onCommentEdit;
  const theme = getViewMermaidTheme(view) ?? 'light';
  view.dispatch({
    effects: compartment.reconfigure(modeExtensions(mode, onLinkClick, theme, onCommentEdit)),
  });
}
