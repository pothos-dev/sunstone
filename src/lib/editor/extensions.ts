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
import { joinConcept, type Property } from '$lib/frontmatter';
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

/**
 * Marks a dispatch as a programmatic document replacement (Concept switch or
 * external-change reload) rather than a user edit, so the change listener does
 * NOT treat it as something to autosave back to disk.
 */
export const programmatic = Annotation.define<boolean>();

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
export function defaultLinkClick(url: string): void {
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
export function modeExtensions(
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
export function editorExtensions(
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
