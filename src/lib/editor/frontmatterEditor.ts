import { EditorView, keymap, type KeyBinding } from '@codemirror/view';
import { EditorState, Annotation, Compartment, type Extension } from '@codemirror/state';
import { defaultKeymap, indentWithTab, redo, undo } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { formatYaml } from '$lib/frontmatter';
import { minimalChange } from '$lib/minimalChange';

import {
  commitFrontmatterGroup,
  dispatchFrontmatter,
  frontmatterField,
} from './frontmatter-field';

// ---------------------------------------------------------------------------
// The Frontmatter Region's YAML editor (ADR 0008)
//
// A SECOND CodeMirror, separate from the body editor, holding the inner YAML of
// the open Concept (no `---` fences — the Region draws those). It deliberately
// runs WITHOUT a history of its own: the body editor owns the single undo stack
// for the whole Concept, this editor mirrors `frontmatterField` out of it, and
// its undo/redo keys forward there. See `frontmatter-field.ts` for the field,
// the inverse effects and the grouping contract.
//
// Data flow, both directions:
//   type here  -> `dispatchFrontmatter(host, yaml)` (no history entry) and a
//                 restarting idle timer; the timer, blur, an explicit save or an
//                 undo closes the run into ONE history entry.
//   host change -> `syncFromHost(yaml)` writes a MINIMAL change into this doc,
//                 annotated `mirrored` so it never bounces back as a user edit.
// ---------------------------------------------------------------------------

/** Idle pause that closes a run of keystrokes into one undo step. */
const GROUP_DELAY_MS = 500;

/** Marks a dispatch as the host->editor mirror, so it is not re-reported. */
const mirrored = Annotation.define<boolean>();

export interface FrontmatterEditorOptions {
  /** DOM node to mount the editor in. */
  parent: HTMLElement;
  /** The body editor: owner of `frontmatterField` and of the undo history. */
  host: EditorView;
  /** The YAML block to open with (inner block, no fences). */
  doc: string;
  /** Read mode shows the same YAML, verbatim and highlighted, but not editable. */
  readOnly: boolean;
  /**
   * Escape from YAML editing — the INNER layer of the unified peel: the Region
   * keeps focus, a second press homes to the body editor (see `appHotkeys`).
   */
  onEscape: () => void;
  /** Focus left the editor: flush the pending write (desktop) after grouping. */
  onBlur?: () => void;
}

export interface FrontmatterEditor {
  /** The underlying view (DOM focus, tests, the format command). */
  view: EditorView;
  /** Mirror a host-side frontmatter value in (undo/redo, reload, switch). */
  syncFromHost(yaml: string): void;
  /** Switch between editable and read-only without rebuilding. */
  setReadOnly(readOnly: boolean): void;
  /** Close any open typing group NOW (blur, save, Concept switch). */
  commitGroup(): void;
  /** Move DOM focus into the YAML. */
  focus(): void;
  /** Tear down: cancels the pending group timer after committing it. */
  destroy(): void;
}

/**
 * Build the Frontmatter Region's YAML editor over `host`'s frontmatter field.
 *
 * The YAML grammar, its highlighting and the well-formedness linter are
 * LAZY-LOADED (`./yamlLanguage`) and reconfigured into `languageSlice` when they
 * arrive, so a collapsed Region costs nothing — the editor is only built when
 * the Region is expanded, and the grammar chunk is only fetched then.
 */
export function buildFrontmatterEditor(options: FrontmatterEditorOptions): FrontmatterEditor {
  const { parent, host, doc, onEscape, onBlur } = options;

  const languageSlice = new Compartment();
  const readOnlySlice = new Compartment();

  // --- grouping: one undo step per idle pause -------------------------------
  // `groupStart` is the frontmatter value the current run of keystrokes began
  // at; `null` means no run is open. See `commitFrontmatterGroup`.
  let groupStart: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function commitGroup(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (groupStart === null) return;
    const start = groupStart;
    groupStart = null;
    commitFrontmatterGroup(host, start);
  }

  function noteEdit(yaml: string): void {
    if (groupStart === null) groupStart = host.state.field(frontmatterField);
    dispatchFrontmatter(host, yaml);
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(commitGroup, GROUP_DELAY_MS);
  }

  // Undo/redo inside the YAML run on the HOST's history — one timeline across
  // frontmatter and body. The open typing group is closed first, so the step
  // about to be undone is the one the user just typed.
  const historyForwarding: KeyBinding[] = [
    { key: 'Mod-z', run: () => (commitGroup(), undo(host)), preventDefault: true },
    { key: 'Mod-y', mac: 'Mod-Shift-z', run: () => (commitGroup(), redo(host)), preventDefault: true },
    { key: 'Mod-Shift-z', run: () => (commitGroup(), redo(host)), preventDefault: true },
    { key: 'Shift-Alt-f', run: formatView, preventDefault: true },
    {
      key: 'Escape',
      run: () => {
        commitGroup();
        onEscape();
        return true;
      },
      preventDefault: true,
    },
  ];

  const state = EditorState.create({
    doc,
    extensions: [
      languageSlice.of([]),
      readOnlySlice.of(readOnlyExtension(options.readOnly)),
      // NO `history()`: the body editor owns the single undo stack (ADR 0008).
      keymap.of(historyForwarding),
      keymap.of([...closeBracketsKeymap, indentWithTab, ...defaultKeymap]),
      closeBrackets(),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        // The host->editor mirror must never bounce back as a user edit.
        if (update.transactions.some((tr) => tr.annotation(mirrored))) return;
        noteEdit(update.state.doc.toString());
      }),
      EditorView.domEventHandlers({
        blur: () => {
          // Close the group BEFORE the host flushes, so the write that follows
          // carries a complete undo step.
          commitGroup();
          onBlur?.();
          return false;
        },
      }),
    ],
  });

  const view = new EditorView({ state, parent });

  // Fetch the grammar + linter and slot them in. The editor is usable (and
  // typed into) while this is in flight; the reconfigure only adds decoration.
  void import('./yamlLanguage').then(({ yamlSupport }) => {
    if (view.dom.isConnected) view.dispatch({ effects: languageSlice.reconfigure(yamlSupport()) });
  });

  return {
    view,
    syncFromHost(yaml: string): void {
      const current = view.state.doc.toString();
      if (current === yaml) return;
      const change = minimalChange(current, yaml);
      if (change === null) return;
      // A host-driven value supersedes whatever run was open here.
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      groupStart = null;
      view.dispatch({ changes: change, annotations: mirrored.of(true) });
    },
    setReadOnly(readOnly: boolean): void {
      view.dispatch({ effects: readOnlySlice.reconfigure(readOnlyExtension(readOnly)) });
    },
    commitGroup,
    focus(): void {
      view.focus();
    },
    destroy(): void {
      commitGroup();
      view.destroy();
    },
  };
}

/** Read mode: same text, same highlighting, no editing. */
function readOnlyExtension(readOnly: boolean): Extension {
  return readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
}

/**
 * The EXPLICIT format command (ADR 0008): reflow the block, preserving comments
 * and quoting. Never runs on save — the `yaml` library normalises whitespace, so
 * formatting on save would reflow every file merely on being edited. No-op when
 * the block does not parse or is already formatted. Returns whether it changed
 * anything. Bound to `Shift-Alt-f` inside the editor and to the Region's Format
 * control.
 */
function formatView(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  const current = view.state.doc.toString();
  const formatted = formatYaml(current);
  if (formatted === null) return false;
  const change = minimalChange(current, formatted);
  if (change === null) return false;
  view.dispatch({ changes: change });
  return true;
}

/** Run the format command against an editor handle (the Region's control). */
export function formatFrontmatter(editor: FrontmatterEditor): boolean {
  return formatView(editor.view);
}
