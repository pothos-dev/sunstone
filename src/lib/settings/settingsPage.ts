/**
 * The settings page's vocabulary and small rules (pure logic; the components
 * under `components/settings/` stay thin over it).
 */

import { FONT_ROLES, type FontRoleName } from '$lib/state/fonts';
import type { BaseColor } from '$lib/state/themeColors';
import { COMMANDS, chordCaps, type CommandSpec, type Keybindings } from './keybindings';

export type SettingsPageId = 'appearance' | 'fonts' | 'layout' | 'keyboard';

export const THEME_MODES = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
] as const;

export const COLOR_LABELS: Record<BaseColor, string> = {
  bg: 'Background',
  bgElevated: 'Panels and dialogs',
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

export interface FontSizeMeta {
  min: number;
  max: number;
  step: number;
  /** The size `app.css` uses when none is set. */
  def: number;
  unit: 'px' | '×';
}

export interface FontRoleMeta {
  label: string;
  hint: string;
  /** Placeholder naming the family in use when none is set. */
  placeholder: string;
  size: FontSizeMeta | null;
  sample: string;
}

const range = (role: 'ui' | 'content' | 'code') => ({ min: FONT_ROLES[role].min, max: FONT_ROLES[role].max });

export const FONT_ROLE_META: Record<FontRoleName, FontRoleMeta> = {
  ui: {
    label: 'Interface',
    hint: 'Sidebars, menus and buttons',
    placeholder: 'Jost',
    size: { ...range('ui'), step: 1, def: 16, unit: 'px' },
    sample: 'Explorer · Backlinks · Quick open',
  },
  content: {
    label: 'Content',
    hint: 'The text of a Concept',
    placeholder: 'Jost',
    size: { ...range('content'), step: 1, def: 14, unit: 'px' },
    sample: 'Light through sunstone, warm on the page.',
  },
  heading: {
    label: 'Headings',
    hint: 'Follows Content when unset; each level keeps its size',
    placeholder: 'Same as Content',
    size: null,
    sample: 'A heading for the Concept',
  },
  code: {
    label: 'Code',
    hint: 'Inline code and code blocks, relative to the text around them',
    placeholder: 'System monospace',
    size: { ...range('code'), step: 0.05, def: 1, unit: '×' },
    sample: 'const bundle = await open("docs/");',
  },
};

/** Families offered as suggestions (any installed family may be typed). */
export const FONT_SUGGESTIONS = [
  'Jost',
  'Inter',
  'IBM Plex Sans',
  'Source Sans 3',
  'system-ui',
  'Charter',
  'Georgia',
  'Iowan Old Style',
  'Literata',
  'serif',
  'JetBrains Mono',
  'Fira Code',
  'Cascadia Code',
  'IBM Plex Mono',
  'ui-monospace',
];

/** `n` clamped to the role's range and rounded to its step, or `null` when it is not a number. */
export function clampFontSize(meta: FontSizeMeta, n: number): number | null {
  if (!Number.isFinite(n)) return null;
  const stepped = Math.round(n / meta.step) * meta.step;
  return Number(Math.min(meta.max, Math.max(meta.min, stepped)).toFixed(2));
}

/**
 * The commands matching `query` (case-insensitive): its label or group contains
 * the query, or every word of it is one of the shortcut's key caps (`ctrl k`
 * finds Quick open without also finding "Go bac*k*").
 */
export function filterCommands(query: string, bindings: Keybindings, mac: boolean): CommandSpec[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...COMMANDS];
  const words = q.split(/\s+/);
  return COMMANDS.filter((c) => {
    if (c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)) return true;
    const chord = bindings[c.id];
    const caps = chord ? chordCaps(chord, mac).map((k) => k.toLowerCase()) : [];
    return words.every((w) => caps.includes(w));
  });
}
