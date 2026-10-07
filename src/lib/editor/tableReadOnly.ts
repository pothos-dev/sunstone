import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

// Reading-mode lock for atomic-editor's table widget.
//
// `tables()` builds every cell with an inner `contenteditable` source div and a
// right-click row/column menu, and commits edits with `view.dispatch` — neither
// of which `EditorState.readOnly` / `EditorView.editable` can stop (readOnly
// blocks CodeMirror's own input handling, not a widget's raw DOM). So in `read`
// mode the document was still typeable through any table. This plugin clears
// the cells' `contenteditable` after every DOM write and swallows the cell
// context menu; leaving reading mode destroys it and hands editability back.
//
// The widget also reveals a mark's delimiters (`**`, `_`, backticks) around the
// caret by flagging its wrap `.active` on focus / mouseup / keyup. A click in a
// locked cell still leaves a selection there, so reading mode showed the raw
// markers. The plugin clears those flags again once the widget's own handlers
// have run.
//
// A locked cell is still focusable (`tabindex=-1`). Reading mode makes the
// editor non-editable, and CodeMirror then re-applies its own selection to the
// DOM on every transaction unless focus sits inside the editor — collapsing a
// double-clicked word in a cell to the widget edge a moment later. Focusing the
// clicked cell keeps the browser's selection there.

const CELL_SOURCE = '.cm-atomic-table-cell-source';

/** The events on which atomic-editor reveals the mark wraps around the caret. */
const REVEAL_EVENTS = ['focusin', 'mouseup', 'keyup'] as const;

/** Collapse every revealed mark wrap in the table cell `target` sits in. */
export function hideCellMarks(target: EventTarget | null): void {
  if (!(target instanceof Element)) return;
  const source = target.closest(CELL_SOURCE);
  if (!source) return;
  for (const el of source.querySelectorAll('.active')) el.classList.remove('active');
}

/**
 * Flip every rendered table cell in `root` between locked (reading) and
 * editable. Idempotent — safe to re-run after each DOM write.
 */
export function setTableCellsEditable(root: ParentNode, editable: boolean): void {
  for (const source of root.querySelectorAll<HTMLElement>(CELL_SOURCE)) {
    source.contentEditable = editable ? 'true' : 'false';
    source.spellcheck = editable;
    if (editable) source.removeAttribute('tabindex');
    else source.tabIndex = -1;
  }
}

/**
 * Read-only gating for table widgets. In `editing` mode this is nothing at all;
 * in `read` mode it locks the cells and blocks the cell context menu (whose
 * items insert/delete rows and columns).
 */
export function readOnlyTables(reading: boolean): Extension {
  if (!reading) return [];
  return ViewPlugin.fromClass(
    class {
      // Capture phase, so it runs before the per-cell `contextmenu` listener
      // atomic-editor attaches; `stopPropagation` alone keeps the platform's
      // own menu (copy) available.
      private readonly blockCellMenu = (event: Event) => {
        const target = event.target;
        if (target instanceof Element && target.closest('.cm-atomic-table')) {
          event.stopPropagation();
        }
      };

      // Bubble phase on the editor root: runs AFTER the cell's own listener
      // (focus fires before focusin), so its `.active` flags are undone.
      private readonly hideMarks = (event: Event) => hideCellMarks(event.target);

      constructor(readonly view: EditorView) {
        view.dom.addEventListener('contextmenu', this.blockCellMenu, true);
        for (const type of REVEAL_EVENTS) view.dom.addEventListener(type, this.hideMarks);
        this.lock();
      }

      update(update: ViewUpdate) {
        // Widget DOM is (re)built during the update; the measure WRITE phase is
        // the first point at which it is in the document.
        if (update.docChanged || update.viewportChanged || update.geometryChanged) {
          this.lock();
        }
      }

      destroy() {
        this.view.dom.removeEventListener('contextmenu', this.blockCellMenu, true);
        for (const type of REVEAL_EVENTS) this.view.dom.removeEventListener(type, this.hideMarks);
        setTableCellsEditable(this.view.dom, true);
      }

      private lock() {
        this.view.requestMeasure({
          read: () => null,
          write: () => setTableCellsEditable(this.view.dom, false),
        });
      }
    },
  );
}
