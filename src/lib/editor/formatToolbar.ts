// The formatting Toolbar's control model (aa-1): which controls it carries,
// their labels and hotkeys, roving-focus keys, and the dispatch from a control
// to the EXISTING editor command. `FormatToolbar.svelte` stays a thin renderer
// over this; no formatting transform lives here or in the component — every
// control runs a command from `commands.ts`, the same one its hotkey runs.

import type { EditorView } from '@codemirror/view';
import { headingCommand, inlineWrapCommand, insertOrEditLink } from './commands';
import type { FormatState } from './formatState';

/** The inline toggles, in Toolbar order. */
export type InlineControlId = 'bold' | 'italic' | 'strike' | 'code';

export interface InlineControl {
  id: InlineControlId;
  label: string;
  /** The wrap marker `inlineWrapCommand` toggles. */
  marker: string;
  /** The CodeMirror key binding (`formattingKeymap` in `extensions.ts`). */
  key: string;
}

/**
 * The inline-format controls. `key` mirrors `formattingKeymap` in
 * `extensions.ts` — it is what the tooltip teaches, so the two must agree
 * (`formatToolbar.test.ts` pins them against the keymap).
 */
export const INLINE_CONTROLS: readonly InlineControl[] = [
  { id: 'bold', label: 'Bold', marker: '**', key: 'Mod-b' },
  { id: 'italic', label: 'Italic', marker: '*', key: 'Mod-i' },
  { id: 'strike', label: 'Strikethrough', marker: '~~', key: 'Mod-Shift-m' },
  { id: 'code', label: 'Inline code', marker: '`', key: 'Mod-e' },
];

/** The heading choices, in menu order: paragraph first, then H1–H6. */
export const HEADING_LEVELS: readonly { level: number; label: string; key: string }[] = [
  { level: 0, label: 'Paragraph', key: 'Mod-0' },
  ...[1, 2, 3, 4, 5, 6].map((level) => ({ level, label: `Heading ${level}`, key: `Mod-${level}` })),
];

/**
 * Render a CodeMirror key binding (`Mod-Shift-m`) the way a person reads it:
 * `Ctrl+Shift+M`, or `Cmd+Shift+M` on macOS (where CodeMirror's `Mod` is Cmd).
 */
export function hotkeyLabel(key: string, mac: boolean): string {
  return key
    .split('-')
    .map((part) => {
      if (part === 'Mod') return mac ? 'Cmd' : 'Ctrl';
      if (part === 'Alt') return mac ? 'Option' : 'Alt';
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join('+');
}

/** A control's tooltip: its label plus the hotkey that does the same thing. */
export function controlTitle(label: string, key: string | null, mac: boolean): string {
  return key ? `${label} (${hotkeyLabel(key, mac)})` : label;
}

/** The heading picker's tooltip, teaching the whole `Mod-0`…`Mod-6` family. */
export function headingTitle(mac: boolean): string {
  const mod = mac ? 'Cmd' : 'Ctrl';
  return `Heading level (${mod}+1 to ${mod}+6; ${mod}+0 for a paragraph)`;
}

/**
 * The link control's label: "Edit link" when the caret is in a link (the
 * control then selects its URL), "Insert link" otherwise — the same split as
 * the editor's right-click menu.
 */
export function linkLabel(state: FormatState): string {
  return state.link ? 'Edit link' : 'Insert link';
}

/**
 * The heading picker's value for a readout: the level as a string, or `''`
 * (the "Mixed" placeholder) when the selection spans different levels.
 */
export function headingValue(state: FormatState): string {
  return state.heading === null ? '' : String(state.heading);
}

/**
 * Roving focus across the Toolbar's controls (WAI-ARIA toolbar pattern): the
 * Toolbar is ONE Tab stop, and Left/Right/Home/End move between its controls,
 * clamping at the ends. Returns the index to focus, or `null` for keys the
 * Toolbar does not own (they keep their default behaviour).
 */
export function rovingIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, current - 1);
    case 'ArrowRight':
      return Math.min(count - 1, current + 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * Whether a keydown is the "focus the Toolbar" chord: Alt+F10, the convention
 * word processors and rich-text editors share for reaching their toolbar from
 * the text. Tab cannot be the way there: in the editor it indents.
 */
export function isToolbarFocusKey(e: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): boolean {
  return e.key === 'F10' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
}

/**
 * Run an inline-format control: the same `inlineWrapCommand` its hotkey runs
 * (read-only guarded), then hand focus back to the editor. The editor's own
 * selection is what the command reads, so a click — which never moves it —
 * formats exactly what was selected.
 */
export function runInlineControl(view: EditorView, id: InlineControlId): void {
  const control = INLINE_CONTROLS.find((c) => c.id === id);
  if (control) inlineWrapCommand(control.marker)(view);
  view.focus();
}

/** Run the heading picker: `headingCommand(level)`, then refocus the editor. */
export function runHeadingControl(view: EditorView, level: number): void {
  headingCommand(level)(view);
  view.focus();
}

/** Run the link control: insert a link, or select the URL of the one under the caret. */
export function runLinkControl(view: EditorView): void {
  insertOrEditLink(view); // refocuses the editor itself
}
