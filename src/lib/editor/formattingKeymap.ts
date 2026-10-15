// The editor's markdown formatting key bindings, in their own module so the
// formatting Toolbar's tests can check that every hotkey it teaches is bound
// (`extensions.ts` itself pulls in SvelteKit-only modules `bun test` cannot load).
import type { KeyBinding } from '@codemirror/view';
import { inlineWrapCommand, headingCommand, annotateCommand } from './commands';

/**
 * Markdown formatting shortcuts (Obsidian-style; `Mod` = Cmd on macOS, Ctrl
 * elsewhere). Everything toggles. Headings follow the de-facto Word/LibreOffice
 * convention (`Mod-1`…`Mod-6`, `Mod-0` for paragraph) since Obsidian ships no
 * heading defaults. These bind keys the app's global handler and the default
 * keymaps leave free; placed ahead of the general keymap so they win.
 */
export const formattingKeymap: KeyBinding[] = [
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
