/**
 * Rebindable keyboard shortcuts (pure logic): the command list, the user's
 * overrides from `config.json` (`keybindings: { "<id>": "<chord>" | null }`),
 * and chord parsing/matching shared by the app's global router
 * (`appHotkeys.ts`), the editor's formatting keys and the settings page.
 *
 * A chord is written the CodeMirror way, `Mod-Shift-f`: modifiers `Mod` (Cmd on
 * macOS, Ctrl elsewhere), `Ctrl`, `Meta`, `Alt`, `Shift`, then the key — a
 * lowercase letter or digit, a printed character (`,` `=` `+`), or a named key
 * (`ArrowLeft`, `Enter`, `F2`). A printed non-letter already carries Shift
 * (`+` vs `=`), so Shift is never part of such a chord.
 *
 * `null` unbinds a command. Shortcuts outside this list (zoom, undo/redo,
 * Escape, Alt+arrows) are FIXED: they keep their keys and are listed only so a
 * rebinding that collides with one is flagged.
 */

export type KeyScope = 'app' | 'editor';

export interface CommandSpec {
  id: string;
  label: string;
  group: 'General' | 'Navigation' | 'Formatting';
  /** `app`: the window-level router; `editor`: only while a CodeMirror editor has focus. */
  scope: KeyScope;
  /** The built-in chord, or `null` for a command that ships unbound. */
  default: string | null;
}

const heading = (n: number): CommandSpec => ({
  id: `heading${n}`,
  label: `Heading ${n}`,
  group: 'Formatting',
  scope: 'editor',
  default: `Mod-${n}`,
});

export const COMMANDS: readonly CommandSpec[] = [
  { id: 'quickNav', label: 'Quick open', group: 'General', scope: 'app', default: 'Mod-k' },
  { id: 'search', label: 'Search in Bundle', group: 'General', scope: 'app', default: 'Mod-Shift-f' },
  { id: 'switchBundle', label: 'Switch Bundle', group: 'General', scope: 'app', default: 'Mod-o' },
  { id: 'settings', label: 'Open settings', group: 'General', scope: 'app', default: 'Mod-,' },
  { id: 'print', label: 'Export as PDF', group: 'General', scope: 'app', default: 'Mod-p' },
  { id: 'find', label: 'Find in Concept', group: 'General', scope: 'app', default: 'Mod-f' },
  { id: 'back', label: 'Go back', group: 'Navigation', scope: 'app', default: 'Ctrl-Alt-ArrowLeft' },
  { id: 'forward', label: 'Go forward', group: 'Navigation', scope: 'app', default: 'Ctrl-Alt-ArrowRight' },
  { id: 'bold', label: 'Bold', group: 'Formatting', scope: 'editor', default: 'Mod-b' },
  { id: 'italic', label: 'Italic', group: 'Formatting', scope: 'editor', default: 'Mod-i' },
  { id: 'code', label: 'Inline code', group: 'Formatting', scope: 'editor', default: 'Mod-e' },
  { id: 'strike', label: 'Strikethrough', group: 'Formatting', scope: 'editor', default: 'Mod-Shift-m' },
  { id: 'annotate', label: 'Add comment', group: 'Formatting', scope: 'editor', default: 'Mod-Alt-m' },
  ...[1, 2, 3, 4, 5, 6].map(heading),
  // Ships unbound: Mod-0 is Reset zoom, and a heading key pressed on its own
  // level already toggles back to a paragraph.
  { id: 'paragraph', label: 'Paragraph', group: 'Formatting', scope: 'editor', default: null },
];

export type CommandId = (typeof COMMANDS)[number]['id'];

export const COMMAND_GROUPS = ['General', 'Navigation', 'Formatting'] as const;

/** Shortcuts that cannot be rebound; checked for collisions only. */
export const FIXED_SHORTCUTS: readonly { label: string; chord: string }[] = [
  { label: 'Zoom in', chord: 'Mod-=' },
  { label: 'Zoom in', chord: 'Mod-+' },
  { label: 'Zoom out', chord: 'Mod--' },
  { label: 'Reset zoom', chord: 'Mod-0' },
  { label: 'Undo', chord: 'Mod-z' },
  { label: 'Redo', chord: 'Mod-Shift-z' },
  { label: 'Redo', chord: 'Mod-y' },
  { label: 'Move focus', chord: 'Alt-ArrowLeft' },
  { label: 'Move focus', chord: 'Alt-ArrowRight' },
  { label: 'Move focus', chord: 'Alt-ArrowUp' },
  { label: 'Move focus', chord: 'Alt-ArrowDown' },
];

/** The effective chord of every command (`null` = unbound). */
export type Keybindings = Readonly<Record<string, string | null>>;

const MODIFIERS = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'] as const;
type Modifier = (typeof MODIFIERS)[number];

interface ParsedChord {
  mods: Set<Modifier>;
  key: string;
}

/** A printed character other than a letter: it already encodes Shift. */
function isPrintedSymbol(key: string): boolean {
  return key.length === 1 && key.toLowerCase() === key.toUpperCase() && !/[0-9]/.test(key);
}

function parseChord(chord: string): ParsedChord | null {
  if (chord === '') return null;
  // The key is everything after the last modifier; a trailing `-` is the key `-`.
  const parts =
    chord === '-' ? ['-'] : chord.endsWith('--') ? [...chord.slice(0, -2).split('-'), '-'] : chord.split('-');
  const key = parts.pop() ?? '';
  if (key === '') return null;
  const mods = new Set<Modifier>();
  for (const p of parts) {
    // Modifiers are matched case-insensitively: the config is written by hand too.
    const mod = MODIFIERS.find((m) => m.toLowerCase() === p.toLowerCase());
    if (!mod) return null;
    mods.add(mod);
  }
  if (key.length > 1 && !/^(Arrow(Left|Right|Up|Down)|Enter|Tab|Space|Backspace|Delete|Home|End|PageUp|PageDown|Insert|F\d{1,2})$/.test(key)) {
    return null;
  }
  const k = key.length === 1 ? key.toLowerCase() : key;
  if (isPrintedSymbol(k)) mods.delete('Shift');
  return { mods, key: k };
}

/** `chord` in canonical form (modifier order, lowercase key), or `null` when it does not parse. */
export function normalizeChord(chord: string): string | null {
  const parsed = parseChord(chord);
  if (!parsed) return null;
  return [...MODIFIERS.filter((m) => parsed.mods.has(m)), parsed.key].join('-');
}

/**
 * The effective bindings: the defaults, with the user's `keybindings` object
 * laid over them. An override is a chord string or `null` (unbound); unknown
 * ids and chords that do not parse are ignored.
 */
export function resolveKeybindings(raw: unknown): Keybindings {
  const out: Record<string, string | null> = {};
  const over = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  for (const c of COMMANDS) {
    const v = over[c.id];
    if (v === null) out[c.id] = null;
    else if (typeof v === 'string' && normalizeChord(v) !== null) out[c.id] = normalizeChord(v);
    else out[c.id] = c.default;
  }
  return out;
}

export const DEFAULT_KEYBINDINGS: Keybindings = resolveKeybindings(null);

/** Whether this is a macOS-style platform (`Mod` = Cmd). */
export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** The key part of a keydown, as a chord would name it, or `null` for a lone modifier. */
function eventKey(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified'].includes(e.key)) return null;
  // Alt on macOS (and some layouts) turns `m` into `µ`: fall back to the physical
  // key. Not for AltGr, whose character is what the user means to type (on
  // Windows it reports Ctrl+Alt, so AltGr+M would otherwise run Mod-Alt-m).
  const code = /^Key([A-Z])$/.exec(e.code)?.[1] ?? /^Digit([0-9])$/.exec(e.code)?.[1];
  const altGr = typeof e.getModifierState === 'function' && e.getModifierState('AltGraph');
  if (e.altKey && code && !altGr) return code.toLowerCase();
  if (e.key === ' ') return 'Space';
  if (e.key.length === 1) return e.key.toLowerCase();
  if (code && !/^[\x20-\x7e]$/.test(e.key)) return code.toLowerCase();
  return e.key;
}

/** The chord a keydown would record as, or `null` for a lone modifier. */
export function chordFromEvent(e: KeyboardEvent, mac = isMacPlatform()): string | null {
  const key = eventKey(e);
  if (key === null) return null;
  const mods: Modifier[] = [];
  if (mac ? e.metaKey : e.ctrlKey) mods.push('Mod');
  if (mac && e.ctrlKey) mods.push('Ctrl');
  if (!mac && e.metaKey) mods.push('Meta');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey && !isPrintedSymbol(key)) mods.push('Shift');
  return [...mods, key].join('-');
}

/**
 * Whether a keydown matches `chord`. By default `Mod` accepts Ctrl OR Cmd on
 * every platform (as the app's global shortcuts always have); with `strict`,
 * `Mod` is the platform's key only (Cmd on macOS, Ctrl elsewhere), as in
 * CodeMirror — the editor's scope, where macOS keeps Ctrl+E/Ctrl+B for moving
 * the cursor. An explicit `Ctrl` needs Ctrl itself. Every other modifier must
 * match exactly.
 */
export function eventMatchesChord(e: KeyboardEvent, chord: string | null, strict?: { mac: boolean }): boolean {
  if (chord === null) return false;
  const parsed = parseChord(chord);
  const key = eventKey(e);
  if (!parsed || key === null || key !== parsed.key) return false;
  const m = parsed.mods;
  if (m.has('Mod') && strict) {
    const primary = strict.mac ? e.metaKey : e.ctrlKey;
    const other = strict.mac ? e.ctrlKey : e.metaKey;
    if (!primary || other !== (strict.mac ? m.has('Ctrl') : m.has('Meta'))) return false;
  } else if (m.has('Mod')) {
    if (!e.ctrlKey && !e.metaKey) return false;
    // `Mod-Ctrl` / `Mod-Meta` (macOS Cmd+Ctrl) need both keys down.
    if ((m.has('Ctrl') || m.has('Meta')) && !(e.ctrlKey && e.metaKey)) return false;
  } else {
    if (e.ctrlKey !== m.has('Ctrl')) return false;
    if (e.metaKey !== m.has('Meta')) return false;
  }
  if (m.has('Alt') !== e.altKey) return false;
  if (!isPrintedSymbol(key) && m.has('Shift') !== e.shiftKey) return false;
  return true;
}

/**
 * The command in `scope` bound to this keydown, or `null`. Editor commands
 * match `Mod` strictly (see `eventMatchesChord`).
 */
export function commandForEvent(
  e: KeyboardEvent,
  bindings: Keybindings,
  scope: KeyScope,
  mac = isMacPlatform(),
): string | null {
  const strict = scope === 'editor' ? { mac } : undefined;
  for (const c of COMMANDS) {
    if (c.scope === scope && eventMatchesChord(e, bindings[c.id] ?? null, strict)) return c.id;
  }
  return null;
}

/**
 * `chord` as this platform presses it: `Mod` stands for Ctrl (or Cmd on macOS),
 * so `Ctrl-Alt-ArrowLeft` and `Mod-Alt-ArrowLeft` are one chord off macOS.
 * `null` when it does not parse.
 */
function platformChord(chord: string, mac: boolean): string | null {
  const parsed = parseChord(chord);
  if (!parsed) return null;
  const same = mac ? 'Meta' : 'Ctrl';
  if (parsed.mods.has(same)) {
    parsed.mods.delete(same);
    parsed.mods.add('Mod');
  }
  return [...MODIFIERS.filter((m) => parsed.mods.has(m)), parsed.key].join('-');
}

/** Whether two chords are the same keys on this platform. */
export function sameChord(a: string | null, b: string | null, mac = isMacPlatform()): boolean {
  if (a === null || b === null) return a === b;
  const pa = platformChord(a, mac);
  return pa !== null && pa === platformChord(b, mac);
}

/**
 * Whether a recorded chord may become a shortcut: it needs Ctrl, Cmd or Alt,
 * unless it is a function key. A bare letter, Space or Enter would fire on
 * every keystroke typed in the editor.
 */
export function isRecordableChord(chord: string): boolean {
  const parsed = parseChord(chord);
  if (!parsed) return false;
  if (/^F\d{1,2}$/.test(parsed.key)) return true;
  return ['Mod', 'Ctrl', 'Meta', 'Alt'].some((m) => parsed.mods.has(m as Modifier));
}

/**
 * Labels of everything else bound to `chord`: other commands (any scope — an
 * app shortcut fires before the editor sees the key) and the fixed shortcuts.
 */
export function chordConflicts(
  chord: string,
  selfId: string,
  bindings: Keybindings,
  mac = isMacPlatform(),
): string[] {
  if (normalizeChord(chord) === null) return [];
  const hits = COMMANDS.filter((c) => c.id !== selfId && sameChord(bindings[c.id] ?? null, chord, mac)).map(
    (c) => c.label,
  );
  for (const f of FIXED_SHORTCUTS) if (sameChord(f.chord, chord, mac) && !hits.includes(f.label)) hits.push(f.label);
  return hits;
}

const MAC_GLYPHS: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Meta: '⌘', Alt: '⌥', Shift: '⇧' };
const KEY_GLYPHS: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };

/** The chord as key caps for display, e.g. `['Ctrl', 'Shift', 'F']`. */
export function chordCaps(chord: string, mac = isMacPlatform()): string[] {
  const parsed = parseChord(chord);
  if (!parsed) return [chord];
  const mods = MODIFIERS.filter((m) => parsed.mods.has(m)).map((m) =>
    mac ? MAC_GLYPHS[m] : m === 'Mod' ? 'Ctrl' : m === 'Meta' ? 'Win' : m,
  );
  const key = KEY_GLYPHS[parsed.key] ?? (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);
  return [...mods, key];
}

/** The chord for a tooltip, e.g. `Ctrl+Shift+F` (`⇧⌘F` on macOS); `''` when unbound. */
export function chordLabel(chord: string | null, mac = isMacPlatform()): string {
  if (chord === null) return '';
  return chordCaps(chord, mac).join(mac ? '' : '+');
}

/** A tooltip naming a command and its current shortcut: `Quick nav (Ctrl+K)`, or just the label when unbound. */
export function withShortcut(label: string, chord: string | null | undefined, mac = isMacPlatform()): string {
  const keys = chordLabel(chord ?? null, mac);
  return keys === '' ? label : `${label} (${keys})`;
}
