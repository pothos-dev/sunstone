import {
  EditorView,
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { findSmartDashes } from './smartDashes';

// Thin CodeMirror layer over `smartDashes.ts` (see there for what qualifies):
// replaces `--` / `---` runs with typographic dash widgets. Follows the
// `citations.ts` mode pattern — reading mode always renders; editing mode
// reveals the raw hyphens when the cursor touches the run, so they stay
// editable.

/** An en/em dash standing in for a `--`/`---` hyphen run. */
class DashWidget extends WidgetType {
  constructor(readonly dash: string) {
    super();
  }
  eq(other: DashWidget): boolean {
    return other.dash === this.dash;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-smart-dash';
    span.textContent = this.dash;
    return span;
  }
}

function computeDashes(view: EditorView, reading: boolean): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const revealCursor = !reading && view.hasFocus;
  const sel = view.state.selection;
  for (const run of findSmartDashes(view.state.doc.toString())) {
    if (revealCursor && sel.ranges.some((r) => r.from <= run.to && r.to >= run.from)) {
      continue; // cursor on the run → show the raw hyphens for editing.
    }
    builder.add(run.from, run.to, Decoration.replace({ widget: new DashWidget(run.dash) }));
  }
  return builder.finish();
}

/**
 * The smart-dashes extension for a given render mode. `reading` renders every
 * dash unconditionally; editing reveals the run under the cursor.
 */
export function smartDashes(reading: boolean): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = computeDashes(view, reading);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.focusChanged
        ) {
          this.decorations = computeDashes(update.view, reading);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
