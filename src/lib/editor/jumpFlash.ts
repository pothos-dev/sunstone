import { EditorView, Decoration, type DecorationSet } from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';

// ---------------------------------------------------------------------------
// Jump-and-flash, shared by the `[n]` citations and the `[^label]` footnotes:
// scroll to a target line and briefly highlight it (`.cm-citation-target`,
// styled by `citationTheme`), so the target is obvious in reading mode where
// there is no caret. Each extension that jumps installs `jumpFlashField`;
// CodeMirror dedupes it.
// ---------------------------------------------------------------------------

/** Effect carrying the offset of a line to flash, or `null` to clear it. */
const setJumpFlash = StateEffect.define<number | null>();

/** Transient highlight on the line a reference just jumped to. */
export const jumpFlashField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setJumpFlash)) continue;
      if (e.value == null) {
        deco = Decoration.none;
      } else {
        const line = tr.state.doc.lineAt(e.value);
        deco = Decoration.set([
          Decoration.line({ class: 'cm-citation-target' }).range(line.from),
        ]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Scroll to `pos` and flash its line. Needs `jumpFlashField` installed. */
export function jumpAndFlash(view: EditorView, pos: number): void {
  view.dispatch({
    effects: [EditorView.scrollIntoView(pos, { y: 'center' }), setJumpFlash.of(pos)],
    // Editable modes: park the caret at the row too. Reading mode has no caret,
    // so the flash carries the feedback.
    selection: view.state.readOnly ? undefined : { anchor: pos },
  });
  // The flash clears after ~1.2s.
  setTimeout(() => {
    view.dispatch({ effects: setJumpFlash.of(null) });
  }, 1200);
}
