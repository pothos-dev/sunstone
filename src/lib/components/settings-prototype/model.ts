// PROTOTYPE — settings page (branch prototype/settings-page). Throwaway.
//
// Question: what should a settings page look like, and does "write only the
// keys the user touched" hold up? Three layouts share this model; the shell
// (`SettingsPrototype.svelte`) switches between them with `?settings=A|B|C`.
//
// The model: a setting is a dot-path into `config.json`. The draft keeps the
// loaded config untouched and records EDITS (path → value, or UNSET to remove
// the key). `applyEdits` lays only those over the original, so unrelated keys,
// their order, and hand-written values survive.

import { BASE_COLORS, type BaseColor } from '$lib/state/themeColors';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

/** An edit that removes the key (a "reset to default"). */
export const UNSET = Symbol('unset');
export type Edit = Json | typeof UNSET;

/** A pretend hand-edited config, used when the backend has none. */
export const SEED_CONFIG: JsonObject = {
  $comment: 'Hand-written. Sunstone must keep this line and the font files below.',
  colors: { dark: { accent: '#5aa2f0' } },
  fonts: {
    code: { family: 'JetBrains Mono', size: 0.9, files: [{ src: 'fonts/JBM.woff2', weight: '100 800' }] },
  },
  'x-myTooling': { lastSync: '2026-10-01' },
};

export function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function getPath(obj: Json | undefined, path: string): Json | undefined {
  let cur: Json | undefined = obj;
  for (const seg of path.split('.')) {
    if (!isObject(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * `original` with only `edits` applied. Existing keys keep their position; new
 * keys append; an UNSET removes the key and prunes objects it leaves empty.
 */
export function applyEdits(original: JsonObject, edits: ReadonlyMap<string, Edit>): JsonObject {
  const out = JSON.parse(JSON.stringify(original)) as JsonObject;
  for (const [path, value] of edits) {
    const segs = path.split('.');
    const parents: JsonObject[] = [out];
    let cur = out;
    for (const seg of segs.slice(0, -1)) {
      if (!isObject(cur[seg])) {
        if (value === UNSET) break;
        cur[seg] = {};
      }
      cur = cur[seg] as JsonObject;
      parents.push(cur);
    }
    const last = segs[segs.length - 1];
    if (value === UNSET) {
      if (parents.length !== segs.length) continue;
      delete cur[last];
      for (let i = parents.length - 1; i > 0; i--) {
        if (Object.keys(parents[i]).length > 0) break;
        delete parents[i - 1][segs[i - 1]];
      }
    } else {
      cur[last] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------- theme mode

export const THEME_MODES = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
] as const;

// ---------------------------------------------------------------- presets

export type Palette = Record<BaseColor, string>;
export interface ThemePreset {
  id: string;
  name: string;
  light: Palette;
  dark: Palette;
}

function p(
  bg: string, bgElevated: string, bgSunken: string,
  text: string, textMuted: string, textFaint: string,
  border: string, borderStrong: string,
  accent: string, accentContrast: string, danger: string, tagText: string,
): Palette {
  return { bg, bgElevated, bgSunken, text, textMuted, textFaint, border, borderStrong, accent, accentContrast, danger, tagText };
}

/** Selectable colour themes. `sunstone` is `app.css` itself (writes no colours). */
export const PRESETS: ThemePreset[] = [
  {
    id: 'sunstone',
    name: 'Sunstone',
    light: p('#fdf3ea', '#fffaf4', '#f6e4d5', '#3a2a20', '#8a6c58', '#b49685', '#ecd6c3', '#ddbda4', '#d9622b', '#fffaf4', '#c62f2f', '#b0491c'),
    dark: p('#1d1511', '#271c16', '#150f0b', '#ecdcd0', '#b39685', '#7d6857', '#3a2c23', '#4d3a2e', '#f0864a', '#1a1109', '#e06a4a', '#f3b48a'),
  },
  {
    id: 'solarized',
    name: 'Solarized',
    light: p('#fdf6e3', '#fffbef', '#eee8d5', '#073642', '#586e75', '#93a1a1', '#e4ddc8', '#d3cbb1', '#268bd2', '#fdf6e3', '#dc322f', '#2aa198'),
    dark: p('#002b36', '#073642', '#00212b', '#eee8d5', '#93a1a1', '#657b83', '#0e4553', '#1a5766', '#268bd2', '#fdf6e3', '#dc322f', '#2aa198'),
  },
  {
    id: 'nord',
    name: 'Nord',
    light: p('#eceff4', '#f5f7fa', '#e5e9f0', '#2e3440', '#4c566a', '#7b88a1', '#d8dee9', '#c2cad8', '#5e81ac', '#eceff4', '#bf616a', '#5e81ac'),
    dark: p('#2e3440', '#3b4252', '#272c36', '#eceff4', '#d8dee9', '#7b88a1', '#434c5e', '#4c566a', '#88c0d0', '#2e3440', '#bf616a', '#8fbcbb'),
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    light: p('#fbf1c7', '#fdf7dc', '#f2e5bc', '#3c3836', '#665c54', '#928374', '#e5d5ad', '#d5c4a1', '#af3a03', '#fbf1c7', '#cc241d', '#79740e'),
    dark: p('#282828', '#32302f', '#1d2021', '#ebdbb2', '#bdae93', '#928374', '#3c3836', '#504945', '#fe8019', '#282828', '#fb4934', '#b8bb26'),
  },
  {
    id: 'catppuccin',
    name: 'Catppuccin',
    light: p('#eff1f5', '#f6f7fa', '#e6e9ef', '#4c4f69', '#6c6f85', '#9ca0b0', '#dce0e8', '#ccd0da', '#8839ef', '#eff1f5', '#d20f39', '#1e66f5'),
    dark: p('#1e1e2e', '#262637', '#181825', '#cdd6f4', '#a6adc8', '#7f849c', '#313244', '#45475a', '#cba6f7', '#1e1e2e', '#f38ba8', '#89b4fa'),
  },
  {
    id: 'rosepine',
    name: 'Rosé Pine',
    light: p('#faf4ed', '#fffaf3', '#f2e9e1', '#575279', '#797593', '#9893a5', '#f2e9e1', '#dfdad9', '#d7827e', '#faf4ed', '#b4637a', '#286983'),
    dark: p('#191724', '#1f1d2e', '#14121d', '#e0def4', '#908caa', '#6e6a86', '#26233a', '#403d52', '#ebbcba', '#191724', '#eb6f92', '#9ccfd8'),
  },
  {
    id: 'github',
    name: 'GitHub',
    light: p('#ffffff', '#ffffff', '#f6f8fa', '#1f2328', '#59636e', '#818b98', '#d1d9e0', '#b7c0ca', '#0969da', '#ffffff', '#d1242f', '#0550ae'),
    dark: p('#0d1117', '#151b23', '#010409', '#f0f6fc', '#9198a1', '#656c76', '#262c36', '#3d444d', '#4493f8', '#0d1117', '#f85149', '#79c0ff'),
  },
  {
    id: 'tokyonight',
    name: 'Tokyo Night',
    light: p('#e1e2e7', '#eceef3', '#d5d6db', '#3760bf', '#6172b0', '#8990b3', '#c4c8da', '#a8aecb', '#2e7de9', '#e1e2e7', '#f52a65', '#9854f1'),
    dark: p('#1a1b26', '#1f2335', '#16161e', '#c0caf5', '#a9b1d6', '#565f89', '#292e42', '#3b4261', '#7aa2f7', '#1a1b26', '#f7768e', '#bb9af7'),
  },
];

export const DEFAULT_PRESET = 'sunstone';

export function presetById(id: unknown): ThemePreset {
  return PRESETS.find((t) => t.id === id) ?? PRESETS[0];
}

export const COLOR_KEYS = Object.keys(BASE_COLORS) as BaseColor[];

export const COLOR_LABELS: Record<BaseColor, string> = {
  bg: 'Background',
  bgElevated: 'Panels & dialogs',
  bgSunken: 'Wells',
  text: 'Text',
  textMuted: 'Muted text',
  textFaint: 'Faint text',
  border: 'Border',
  borderStrong: 'Strong border',
  accent: 'Accent',
  accentContrast: 'Text on accent',
  danger: 'Danger',
  tagText: 'Tag text',
};

/**
 * The colours a scheme ends up with: the chosen preset, then any per-key
 * `colors.<scheme>.<key>` override from config on top.
 */
export function effectivePalette(config: JsonObject, scheme: 'light' | 'dark'): Palette {
  const base = presetById(config.colorTheme ?? DEFAULT_PRESET)[scheme];
  const over = getPath(config, `colors.${scheme}`);
  const out = { ...base };
  if (isObject(over)) for (const k of COLOR_KEYS) if (typeof over[k] === 'string') out[k] = over[k] as string;
  return out;
}

/**
 * The `{ colors, fonts }` value `appearanceCss` takes, with the preset folded
 * into `colors` (the real implementation would do this in Rust or `appearance.ts`).
 */
export function appearanceInput(config: JsonObject): { colors: unknown; fonts: unknown } {
  const preset = config.colorTheme;
  const colors =
    preset !== undefined && preset !== DEFAULT_PRESET
      ? { light: effectivePalette(config, 'light'), dark: effectivePalette(config, 'dark') }
      : config.colors;
  return { colors, fonts: config.fonts };
}

// ---------------------------------------------------------------- fonts

export const FONT_ROLE_LABELS = {
  ui: { label: 'Interface', hint: 'Sidebar, menus, buttons', defaultFamily: 'Jost', size: { min: 8, max: 32, step: 1, unit: 'px', def: 14 } },
  content: { label: 'Content', hint: 'Body text of a Concept', defaultFamily: 'Jost', size: { min: 8, max: 48, step: 1, unit: 'px', def: 16 } },
  heading: { label: 'Headings', hint: 'Follows Content when unset', defaultFamily: '(Content font)', size: null },
  code: { label: 'Code', hint: 'Inline code and code blocks', defaultFamily: 'System monospace', size: { min: 0.5, max: 2, step: 0.05, unit: '×', def: 0.875 } },
} as const;

export type FontRole = keyof typeof FONT_ROLE_LABELS;
export const FONT_ROLES = Object.keys(FONT_ROLE_LABELS) as FontRole[];

/** Families offered in the picker (a real build could ask the OS for its list). */
export const FONT_SUGGESTIONS = [
  'Jost', 'Inter', 'IBM Plex Sans', 'Source Sans 3', 'system-ui',
  'Charter', 'Georgia', 'Iowan Old Style', 'Literata', 'Fraunces', 'serif',
  'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'IBM Plex Mono', 'ui-monospace',
];

// ---------------------------------------------------------------- panel defaults

export const PANEL_DEFAULTS = [
  { key: 'leftSidebar', label: 'Left sidebar', def: true },
  { key: 'explorer', label: 'Explorer', def: true },
  { key: 'tags', label: 'Tags', def: false },
  { key: 'rightSidebar', label: 'Right sidebar', def: false },
  { key: 'outline', label: 'Outline', def: true },
  { key: 'backlinks', label: 'Backlinks', def: true },
  { key: 'frontmatter', label: 'Frontmatter', def: false },
  { key: 'titles', label: 'Label by frontmatter title', def: true },
] as const;

export const EDITOR_MODES = [
  { id: 'read', label: 'Read' },
  { id: 'editing', label: 'Editing' },
] as const;

// ---------------------------------------------------------------- keybindings

export interface Command {
  id: string;
  label: string;
  group: 'General' | 'Navigation' | 'Editor' | 'Formatting';
  /** Chord in `Mod+Shift+K` form; `Mod` is Ctrl, or Cmd on macOS. */
  def: string;
  /** Where the binding is live; the same chord in two scopes is shadowing, not a clash. */
  scope: 'global' | 'editor';
}

export const COMMANDS: Command[] = [
  { id: 'quickNav', label: 'Quick open', group: 'General', def: 'Mod+K', scope: 'global' },
  { id: 'search', label: 'Search in Bundle', group: 'General', def: 'Mod+Shift+F', scope: 'global' },
  { id: 'switchBundle', label: 'Switch Bundle', group: 'General', def: 'Mod+O', scope: 'global' },
  { id: 'settings', label: 'Open settings', group: 'General', def: 'Mod+,', scope: 'global' },
  { id: 'print', label: 'Export as PDF', group: 'General', def: 'Mod+P', scope: 'global' },
  { id: 'zoomIn', label: 'Zoom in', group: 'General', def: 'Mod+=', scope: 'global' },
  { id: 'zoomOut', label: 'Zoom out', group: 'General', def: 'Mod+-', scope: 'global' },
  { id: 'zoomReset', label: 'Reset zoom', group: 'General', def: 'Mod+0', scope: 'global' },
  { id: 'back', label: 'Go back', group: 'Navigation', def: 'Ctrl+Alt+ArrowLeft', scope: 'global' },
  { id: 'forward', label: 'Go forward', group: 'Navigation', def: 'Ctrl+Alt+ArrowRight', scope: 'global' },
  { id: 'focusLeft', label: 'Focus region left', group: 'Navigation', def: 'Alt+ArrowLeft', scope: 'global' },
  { id: 'focusRight', label: 'Focus region right', group: 'Navigation', def: 'Alt+ArrowRight', scope: 'global' },
  { id: 'focusUp', label: 'Focus region up', group: 'Navigation', def: 'Alt+ArrowUp', scope: 'global' },
  { id: 'focusDown', label: 'Focus region down', group: 'Navigation', def: 'Alt+ArrowDown', scope: 'global' },
  { id: 'find', label: 'Find in Concept', group: 'Editor', def: 'Mod+F', scope: 'global' },
  { id: 'undo', label: 'Undo', group: 'Editor', def: 'Mod+Z', scope: 'global' },
  { id: 'redo', label: 'Redo', group: 'Editor', def: 'Mod+Shift+Z', scope: 'global' },
  { id: 'bold', label: 'Bold', group: 'Formatting', def: 'Mod+B', scope: 'editor' },
  { id: 'italic', label: 'Italic', group: 'Formatting', def: 'Mod+I', scope: 'editor' },
  { id: 'code', label: 'Inline code', group: 'Formatting', def: 'Mod+E', scope: 'editor' },
  { id: 'strike', label: 'Strikethrough', group: 'Formatting', def: 'Mod+Shift+M', scope: 'editor' },
  { id: 'annotate', label: 'Add comment', group: 'Formatting', def: 'Mod+Alt+M', scope: 'editor' },
  { id: 'paragraph', label: 'Paragraph', group: 'Formatting', def: 'Mod+0', scope: 'editor' },
  ...[1, 2, 3, 4, 5, 6].map(
    (n): Command => ({ id: `heading${n}`, label: `Heading ${n}`, group: 'Formatting', def: `Mod+${n}`, scope: 'editor' }),
  ),
];

export const COMMAND_GROUPS = ['General', 'Navigation', 'Editor', 'Formatting'] as const;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** `Mod+Shift+K` from a keydown, or null while only modifiers are down. */
export function chordFromEvent(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const parts: string[] = [];
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod) parts.push('Mod');
  if (isMac && e.ctrlKey) parts.push('Ctrl');
  if (!isMac && e.metaKey) parts.push('Meta');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  parts.push(key);
  return parts.join('+');
}

const GLYPHS: Record<string, string> = isMac
  ? { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' }
  : { Mod: 'Ctrl', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };

/** The chord as key caps for display, e.g. `['Ctrl', 'Shift', 'F']`. */
export function chordCaps(chord: string): string[] {
  return chord.split('+').map((k) => GLYPHS[k] ?? (k.length === 1 ? k.toUpperCase() : k));
}

/**
 * Commands whose chord equals `chord` in an overlapping scope. A global binding
 * and an editor one with the same chord do collide: the global handler runs first.
 */
export function conflicts(chord: string, selfId: string, bindings: (id: string) => string): Command[] {
  return COMMANDS.filter((c) => c.id !== selfId && bindings(c.id).toLowerCase() === chord.toLowerCase());
}
