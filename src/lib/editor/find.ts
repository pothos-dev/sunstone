import { EditorView, keymap } from '@codemirror/view';
import { type Extension } from '@codemirror/state';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';

// ---------------------------------------------------------------------------
// In-Concept Find & Replace (slices: in-concept-find / in-concept-replace)
//
// We mount @codemirror/search's BUILT-IN panel ABOVE the editor (`top: true`)
// rather than hand-rolling a Svelte panel. Defaults give us case-insensitive
// literal find (`caseSensitive: false`, `literal: false`/regexp off) with the
// case / whole-word / regexp toggles still present, and replace / replace-all
// for free. Replace flows through ordinary doc transactions, so it rides the
// existing autosave (`onChange`) and CM undo/redo with no new persistence path.
//
// Scope is the body only: the CodeMirror doc holds only the body (frontmatter
// lives in `frontmatterField` and its own editor, ADR 0008), so find/replace
// never touch it.
//
// `Ctrl/Cmd+F` is owned by App.svelte (so it grabs focus app-wide); the search
// keymap here still provides in-panel bindings (Enter = next, Esc = close, etc.)
// and the other find affordances. App calls `openSearch(view)` to open + focus.
//
// The panel is themed below with Sunstone's design tokens so it reads as editor
// chrome (matching the nav bar / inputs) rather than CM's default grey panel.
// ---------------------------------------------------------------------------

/** Theme the built-in search panel with Sunstone's design tokens. */
export const findPanelTheme = EditorView.theme({
  '.cm-panel.cm-search': {
    padding: '0.4rem 0.6rem',
    backgroundColor: 'var(--bg-elevated)',
    color: 'var(--text)',
    borderBottom: '1px solid var(--border)',
    fontFamily: 'var(--font-ui)',
    fontSize: '0.85rem',
  },
  '.cm-panel.cm-search label': {
    fontSize: '0.78rem',
    color: 'var(--text-muted)',
    marginLeft: '0.2rem',
  },
  '.cm-panel.cm-search .cm-textfield': {
    backgroundColor: 'var(--bg)',
    color: 'var(--text)',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius-sm)',
    padding: '0.2rem 0.4rem',
    fontFamily: 'var(--font-ui)',
  },
  '.cm-panel.cm-search .cm-textfield:focus-visible': {
    outline: 'none',
    borderColor: 'var(--accent)',
    boxShadow: '0 0 0 2px var(--accent-soft)',
  },
  '.cm-panel.cm-search .cm-button': {
    backgroundColor: 'var(--bg)',
    backgroundImage: 'none',
    color: 'var(--text)',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius-sm)',
    padding: '0.2rem 0.55rem',
    fontFamily: 'var(--font-ui)',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search .cm-button:hover': {
    backgroundColor: 'var(--hover)',
  },
  '.cm-panel.cm-search .cm-button:focus-visible': {
    outline: 'none',
    boxShadow: '0 0 0 2px var(--accent-soft)',
  },
  '.cm-panel.cm-search [name=close]': {
    color: 'var(--text-muted)',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search [name=close]:hover': {
    color: 'var(--text)',
  },
});

/**
 * The find extension set: the built-in search panel mounted above the editor
 * plus its keymap. Tagging the panel with `data-testid` is done in
 * `openSearch`, since the built-in `SearchPanel` class is not exported.
 */
export function findExtensions(): Extension[] {
  return [search({ top: true }), keymap.of(searchKeymap)];
}

/**
 * Open (and focus) the in-Concept find panel for `view`. Called by App.svelte's
 * `Ctrl/Cmd+F` handler so the binding works from anywhere in the app. Seeding
 * the find field from the current selection is the built-in panel's default.
 * Also tags the panel DOM with `data-testid` hooks for e2e selection.
 */
export function openSearch(view: EditorView): void {
  openSearchPanel(view);
  // The built-in panel renders synchronously into the DOM; tag it (and its
  // fields) for stable e2e selection. Idempotent: re-tagging is harmless.
  const panel = view.dom.querySelector('.cm-search');
  if (panel) {
    panel.setAttribute('data-testid', 'find-panel');
    panel.querySelector('[name=search]')?.setAttribute('data-testid', 'find-input');
    panel.querySelector('[name=replace]')?.setAttribute('data-testid', 'replace-input');
    panel.querySelector('[name=next]')?.setAttribute('data-testid', 'find-next');
    panel.querySelector('[name=prev]')?.setAttribute('data-testid', 'find-prev');
    panel.querySelector('button[name=replace]')?.setAttribute('data-testid', 'find-replace');
    panel.querySelector('[name=replaceAll]')?.setAttribute('data-testid', 'find-replace-all');
    panel.querySelector('[name=close]')?.setAttribute('data-testid', 'find-close');
  }
}
