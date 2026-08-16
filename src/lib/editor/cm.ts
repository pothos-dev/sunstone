import {
  EditorView,
  keymap,
  highlightActiveLine,
  drawSelection,
  type KeyBinding,
} from '@codemirror/view';
import { EditorState, Annotation, Compartment, type Extension } from '@codemirror/state';
import {
  history,
  historyKeymap,
  defaultKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { indentOnInput } from '@codemirror/language';
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { backend } from '$lib/ipc';
import { joinConcept, serializeFrontmatter, type Property } from '$lib/frontmatter';
import { minimalChange } from '$lib/minimalChange';
import {
  inlinePreview,
  imageBlocks,
  tables,
  atomicEditorTheme,
  atomicMarkdownSyntax,
} from '@atomic-editor/editor';
// Lazy-loaded fenced-code grammars. Each entry's `load()` is a dynamic
// `import('@codemirror/lang-*')`, so the bundler splits every grammar into its
// own chunk and only the languages actually used in a document are fetched.
import { ATOMIC_CODE_LANGUAGES } from '@atomic-editor/editor/code-languages';
import '@atomic-editor/editor/styles.css';

import {
  setFrontmatter,
  frontmatterField,
  frontmatterUndo,
} from './frontmatter-field';
import { brokenLinks, brokenLinkTheme, type BrokenLinkContext } from './broken-links';
import { mermaidBlocks } from './mermaid';
import type { ResolvedTheme } from './mermaidBlocks';
import { wikiLinksExtension, wikiLinkTheme, type WikiLinkContext } from './wiki-links';
import { citations, citationTheme } from './citations';
import { criticMarkupAnnotations, criticMarkupTheme, type OnCommentEdit } from './criticMarkupView';
import { anchorTracking } from './anchor-tracking';
import { findExtensions, findPanelTheme } from './find';
import { inlineWrapCommand, headingCommand, annotateCommand } from './commands';
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
 * Marks a dispatch as a programmatic document replacement (Concept switch or
 * external-change reload) rather than a user edit, so the change listener does
 * NOT treat it as something to autosave back to disk.
 */
const programmatic = Annotation.define<boolean>();

/**
 * Force every atomic-editor link label to the link accent colour.
 *
 * A link label rendered inside a list item picks up the base-text highlight tag
 * ON TOP of the link tag; the two class rules have equal specificity, so the
 * (later-emitted) base-text rule wins the cascade and the label renders in the
 * body colour — only the accent underline survives. Links then look inconsistent
 * between paragraphs (accent label) and lists (body-coloured label). Colouring
 * the label spans directly (higher specificity than the single-class highlight
 * rule) makes every resolved link read the same. Broken / unresolved links
 * re-assert `--danger` on their own label spans with `!important`
 * (`brokenLinkTheme`, `wikiLinkTheme`), so they still win over this.
 */
const atomicLinkTheme = EditorView.theme({
  '.cm-atomic-link span': { color: 'var(--atomic-editor-link)' },
});

export interface BuildEditorOptions {
  parent: HTMLElement;
  /** The markdown BODY (no frontmatter) to seed the document with. */
  doc: string;
  /** The Concept's initial frontmatter properties (ADR 0003). */
  frontmatter?: Property[];
  /**
   * Bundle-relative path of the Concept this view starts on. Recorded so
   * `setEditorConcept` can detect a Concept SWITCH (path change) and rebuild the
   * state with a fresh history (unified-undo: history never crosses Concepts).
   */
  path?: string | null;
  /** The view mode to build the editor in (default `read`). */
  initialMode?: EditorMode;
  /**
   * Called with the new FULL Concept markdown (`serialize(frontmatter) + body`)
   * after a user edit to either the body or the frontmatter, for autosave.
   */
  onChange?: (content: string) => void;
  /**
   * Called whenever the frontmatter field changes (user edit, Concept switch, or
   * external reload), so the Properties panel can render the current properties.
   */
  onFrontmatterChange?: (props: Property[]) => void;
  /** called when the editor loses focus */
  onBlur?: () => void;
  /**
   * Called after any transaction that may change the undo/redo history depth
   * (body edit, frontmatter edit, programmatic replacement) and after a state
   * rebuild on Concept switch. Lets the host mirror `undoDepth`/`redoDepth` into
   * reactive UI state for the Properties-panel undo/redo buttons.
   */
  onHistory?: () => void;
  /**
   * Called when the user clicks a rendered link in the live preview (inline
   * links and table-cell links). See the slice-5 seam below.
   */
  onLinkClick?: (url: string) => void;
  /**
   * Context for broken-link styling: the open Concept's path (for relative-link
   * resolution) and a synchronous existence check against the Bundle index. When
   * omitted, broken-link styling is disabled (links render normally).
   */
  brokenLinkContext?: BrokenLinkContext;
  /**
   * Context for wikilink rendering/navigation (ADR-0004): the open Concept's
   * path, the full concept-path list, a synchronous existence check, and an
   * in-app open callback. When omitted, wikilinks render as plain `[[ ]]` text.
   */
  wikiLinkContext?: WikiLinkContext;
  /**
   * Called when a CriticMarkup comment gutter icon is clicked, so the host can
   * open the annotation popup to edit that note (works in reading mode too — the
   * preferred way to annotate). When omitted, an icon click falls back to parking
   * the caret in the raw note.
   */
  onCommentEdit?: OnCommentEdit;
}

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
 * SLICE 5 SEAM — OKF link navigation.
 *
 * atomic-editor routes every rendered-link click (inline links + table-cell
 * link icons) through one `onLinkClick(url)` callback. For now we route to a
 * safe default: open external (http/https) URLs in a new tab, and ignore
 * relative/OKF links (`./rel.md`, `/abs.md`) rather than opening a blank tab.
 *
 * Slice 5 plugs OKF navigation in here by passing its own `onLinkClick` via
 * `BuildEditorOptions` — it resolves the OKF path against the open Concept and
 * navigates in-app. No restructuring needed: just provide the callback.
 */
function defaultLinkClick(url: string): void {
  if (typeof window === 'undefined') return;
  // External links: open in a new tab. Relative / OKF links are left for
  // slice 5; opening them as URLs here would be wrong, so we no-op.
  if (/^https?:\/\//i.test(url)) {
    // Route through the backend seam: WebKitGTK swallows `window.open`, so the
    // desktop impl hands the URL to the OS's default browser via the opener
    // plugin (the fake/HTTP impls open a new tab).
    void backend.openExternal(url);
  }
  // else: relative/OKF link — TODO(slice 5): resolve + navigate in-app.
}

/**
 * The editor's two view modes — a boolean `editing`, kept as a string union so
 * it round-trips through the persisted `Option<String>` bundle-state config:
 *   - `editing` — live preview (ADR-0001): inactive lines render styled and the
 *                 cursor line shows raw markup; the document is editable.
 *   - `read`    — reading mode (the default): every line renders, no raw markup,
 *                 read-only.
 * (The old three-way `edit`/`hybrid`/`view` collapsed here: `edit`+`hybrid` →
 * `editing`, `view` → `read`. Legacy persisted values migrate on read; see
 * `migrateEditorMode` in `layoutPersist.ts`.)
 */
export type EditorMode = 'editing' | 'read';

/** The default mode for a freshly-built view when none is specified. */
export const DEFAULT_EDITOR_MODE: EditorMode = 'read';

/**
 * The STATIC live-preview foundation present in EVERY mode: the GFM parser
 * (read by both the decoration extensions and source-mode syntax colouring),
 * syntax highlighting and the atomic theme. MUST come before the mode-dependent
 * decoration extensions so they can read Task / Table / FencedCode nodes.
 */
function livePreviewBase(): Extension[] {
  return [
    markdown({ base: markdownLanguage, codeLanguages: ATOMIC_CODE_LANGUAGES }),
    atomicMarkdownSyntax,
    atomicEditorTheme,
  ];
}

/**
 * The MODE-DEPENDENT extension slice, held in a Compartment so the host can
 * toggle editing at runtime (`setEditorMode`) without rebuilding the view:
 *   - whether inline preview renders every line (`read`, via atomic-editor's
 *     patched `alwaysRender`) or reveals the cursor line (`editing`);
 *   - the read-only / editable gating (`read` is read-only).
 * The active-line highlight is included for `editing` only — reading view has no
 * editing caret to anchor it.
 */
function modeExtensions(
  mode: EditorMode,
  onLinkClick: (url: string) => void,
  theme: ResolvedTheme,
  onCommentEdit?: OnCommentEdit,
): Extension[] {
  const reading = mode === 'read';
  return [
    tables({ onLinkClick }),
    imageBlocks(),
    // Render ` ```mermaid ` fences as Diagrams (ADR-0005). `reading` (read):
    // always rendered; `editing`: cursor inside reveals the raw fence.
    // `theme` bakes the diagram colours; a flip reconfigures this Compartment.
    mermaidBlocks(reading, theme),
    inlinePreview({ onLinkClick, alwaysRender: reading }),
    // Citation references: inline `[n]` following a word render as superscript
    // links that jump to the `[n] …` row of the citation table (citation-
    // superscripts). `reading` always renders; `editing` reveals the token under
    // the cursor. Placed after inlinePreview so the replace decoration overrides
    // the stray reference-link syntax colour on the middle number.
    citations(reading),
    // CriticMarkup annotations (highlight background, hidden delimiters/comment,
    // gutter icon + hover note). Cursor-inside reveals raw markup for editing.
    criticMarkupAnnotations(reading, onCommentEdit),
    ...(reading ? [] : [highlightActiveLine()]),
    // `editable` controls the DOM `contenteditable`; `readOnly` blocks edits at
    // the state level. Reading view is locked; hybrid stays editable.
    EditorState.readOnly.of(reading),
    EditorView.editable.of(!reading),
  ];
}

/**
 * Markdown formatting shortcuts (Obsidian-style; `Mod` = Cmd on macOS, Ctrl
 * elsewhere). Everything toggles. Headings follow the de-facto Word/LibreOffice
 * convention (`Mod-1`…`Mod-6`, `Mod-0` for paragraph) since Obsidian ships no
 * heading defaults. These bind keys the app's global handler and the default
 * keymaps leave free; placed ahead of the general keymap so they win.
 */
const formattingKeymap: KeyBinding[] = [
  { key: 'Mod-b', run: inlineWrapCommand('**'), preventDefault: true },
  { key: 'Mod-i', run: inlineWrapCommand('*'), preventDefault: true },
  { key: 'Mod-e', run: inlineWrapCommand('`'), preventDefault: true },
  { key: 'Mod-Shift-m', run: inlineWrapCommand('~~'), preventDefault: true },
  { key: 'Mod-1', run: headingCommand(1), preventDefault: true },
  { key: 'Mod-2', run: headingCommand(2), preventDefault: true },
  { key: 'Mod-3', run: headingCommand(3), preventDefault: true },
  { key: 'Mod-4', run: headingCommand(4), preventDefault: true },
  { key: 'Mod-5', run: headingCommand(5), preventDefault: true },
  { key: 'Mod-6', run: headingCommand(6), preventDefault: true },
  { key: 'Mod-0', run: headingCommand(0), preventDefault: true },
  // Toggle a CriticMarkup highlight+comment annotation ('m' for comment/margin).
  { key: 'Mod-Alt-m', run: annotateCommand, preventDefault: true },
];

/**
 * Everything BELOW the frontmatter field in the extension list: the live-preview
 * set, broken-link styling, history, keymaps and the change/blur listeners.
 * Shared verbatim by the initial build AND by `setEditorConcept`'s state rebuild
 * on Concept switch, so the two cannot drift. The frontmatter field is seeded
 * separately by each caller (the value differs), but the BEHAVIOUR is here.
 */
function editorExtensions(
  opts: Omit<BuildEditorOptions, 'parent' | 'doc' | 'frontmatter'>,
  wikiCompartment: Compartment,
  livePreviewCompartment: Compartment,
  mode: EditorMode,
  theme: ResolvedTheme,
): Extension[] {
  const { onChange, onFrontmatterChange, onBlur, onHistory, onLinkClick, brokenLinkContext, wikiLinkContext, onCommentEdit } = opts;

  // Notify on user edits to the body OR the frontmatter. Frontmatter edits are
  // carried by `setFrontmatter` effects (no doc change), so we watch for both.
  // Debouncing happens in the store.
  const changeListener = EditorView.updateListener.of((update) => {
    const fmChanged = update.transactions.some((tr) =>
      tr.effects.some((e) => e.is(setFrontmatter)),
    );
    if (!update.docChanged && !fmChanged) return;
    // History depth may have changed (body/frontmatter edit, undo, redo); keep
    // the host's reactive undo/redo state in sync for the panel buttons.
    onHistory?.();
    // Mirror the frontmatter out on every field change (incl. programmatic
    // Concept switches / reloads) so the Properties panel stays in sync.
    if (fmChanged) onFrontmatterChange?.(update.state.field(frontmatterField));
    if (!onChange) return;
    // Skip programmatic replacements (Concept switch / external reload).
    const isProgrammatic = update.transactions.some((tr) => tr.annotation(programmatic));
    if (isProgrammatic) return;
    onChange(joinConcept(update.state.field(frontmatterField), update.state.doc.toString()));
  });

  // Save-on-blur: flush any pending autosave when focus leaves the editor.
  const blurListener = EditorView.domEventHandlers({
    blur: () => {
      onBlur?.();
      return false;
    },
  });

  return [
    ...livePreviewBase(),
    // Mode-dependent slice (decorations + read-only gating) in a Compartment so
    // `setEditorMode` can switch edit/hybrid/view without rebuilding the view.
    livePreviewCompartment.of(modeExtensions(mode, onLinkClick ?? defaultLinkClick, theme, onCommentEdit)),
    // In-Concept Find & Replace: built-in search panel (mounted above the
    // editor) + its keymap, themed as editor chrome. Ctrl/Cmd+F is opened by
    // App.svelte via `openSearch`; the keymap supplies in-panel bindings.
    ...findExtensions(),
    findPanelTheme,
    // Consistent accent colour for every resolved link label (see the theme's
    // note). Added BEFORE the broken/wikilink themes so their `!important`
    // danger colour still wins for unresolved links.
    atomicLinkTheme,
    // Broken-link styling (only when the index context is provided). Placed
    // after the live-preview extensions so its mark class layers on top of
    // atomic-editor's `.cm-atomic-link` decoration.
    ...(brokenLinkContext ? [brokenLinks(brokenLinkContext), brokenLinkTheme] : []),
    // Wikilink rendering/navigation (ADR-0004), wrapped in a Compartment so the
    // host can reconfigure it on index change to clear the extension's
    // resolve-cache (it has no invalidation API). The theme stays outside the
    // compartment (static). Empty config when no context is supplied.
    wikiCompartment.of(wikiLinkContext ? wikiLinksExtension(wikiLinkContext) : []),
    ...(wikiLinkContext ? [wikiLinkTheme] : []),
    // CriticMarkup annotation styling. A static theme, harmless in all modes
    // (the decorations themselves are only active outside `edit`).
    criticMarkupTheme,
    // Citation superscript-link + jump-target styling (static; the decorations
    // are mode-gated in `modeExtensions`).
    citationTheme,
    // Heading-identity tracking for slug-anchor rewriting (slug-anchor-rewrite):
    // baselines the open Concept's heading slugs and follows each heading across
    // edits so the host can rewrite inbound anchors when a heading is renamed.
    // A fresh state (Concept switch) re-seeds the baseline via the field's
    // `create`.
    anchorTracking,
    // Editing affordances that make the hybrid preview feel like Obsidian.
    history(),
    // Unified undo: record the inverse of each frontmatter mutation so the
    // editor history can undo/redo frontmatter alongside body edits. MUST stay
    // immediately after `history()` (and paired with `frontmatterField`).
    frontmatterUndo,
    drawSelection(),
    indentOnInput(),
    closeBrackets(),
    // Markdown formatting shortcuts (Ctrl/Cmd+B, +I, +E, +Shift+M, headings).
    // Placed BEFORE the general keymap so its bindings take precedence.
    keymap.of(formattingKeymap),
    keymap.of([
      ...closeBracketsKeymap,
      ...historyKeymap,
      ...markdownKeymap,
      indentWithTab,
      ...defaultKeymap,
    ]),
    EditorView.lineWrapping,
    changeListener,
    blurListener,
  ];
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

/**
 * The 1-based editor line sitting `offsetPx` below the top of the scroll
 * viewport — the probe the Outline's active-heading highlight rides on
 * (outline-active-heading). Returns null when the geometry is not measurable
 * yet (view not laid out / detached).
 */
export function lineAtViewportTop(view: EditorView, offsetPx: number): number | null {
  const rect = view.scrollDOM.getBoundingClientRect();
  if (rect.height === 0) return null;
  // Probe a little in from the left edge so the gutter never swallows the hit,
  // and clamp the y into the viewport so a short document still answers.
  const y = Math.min(rect.top + offsetPx, rect.bottom - 1);
  const pos = view.posAtCoords({ x: rect.left + 8, y }, false);
  return view.state.doc.lineAt(pos).number;
}

/**
 * Scroll the editor to (and place the cursor at the start of) `line`, a 1-based
 * line number. Used by full-text search to reveal the matching line after
 * opening a Concept. Clamps out-of-range lines (the doc may differ slightly
 * from the searched snapshot). Marked programmatic so the selection change is
 * not mistaken for a user edit.
 */
export function scrollToLine(
  view: EditorView,
  line: number,
  y: 'center' | 'start' = 'center',
): void {
  const total = view.state.doc.lines;
  const clamped = Math.max(1, Math.min(line, total));
  const pos = view.state.doc.line(clamped).from;
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y }),
    annotations: programmatic.of(true),
  });
}
