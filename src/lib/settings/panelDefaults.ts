/**
 * How a Bundle opens the first time (pure logic): which Sidebars and Sections
 * are expanded, whether frontmatter and titles show, and the editor mode. Set
 * on the settings page under `defaults` in `config.json`; a Bundle that has
 * been opened before keeps its own remembered layout
 * (`sessionFromBundleState` uses these only for fields its state lacks).
 */

import type { EditorMode } from '$lib/editor/cm';

export interface PanelDefaults {
  leftSidebar: boolean;
  explorer: boolean;
  tags: boolean;
  rightSidebar: boolean;
  outline: boolean;
  backlinks: boolean;
  frontmatter: boolean;
  titles: boolean;
  editorMode: EditorMode;
}

export type PanelToggle = Exclude<keyof PanelDefaults, 'editorMode'>;

/** The built-in defaults (what Sunstone did before this was configurable). */
export const BUILTIN_PANEL_DEFAULTS: PanelDefaults = {
  leftSidebar: true,
  explorer: true,
  tags: false,
  rightSidebar: false,
  outline: true,
  backlinks: true,
  frontmatter: false,
  titles: true,
  editorMode: 'read',
};

/** The toggles in the order the settings page lists them. */
export const PANEL_TOGGLES: readonly { key: PanelToggle; label: string }[] = [
  { key: 'leftSidebar', label: 'Left Sidebar' },
  { key: 'explorer', label: 'Explorer' },
  { key: 'tags', label: 'Tags' },
  { key: 'rightSidebar', label: 'Right Sidebar' },
  { key: 'outline', label: 'Outline' },
  { key: 'backlinks', label: 'Backlinks' },
  { key: 'frontmatter', label: 'Frontmatter' },
  { key: 'titles', label: 'Label by frontmatter title' },
];

/** The `defaults` object from `config.json` over the built-ins; wrong-typed values are ignored. */
export function resolvePanelDefaults(raw: unknown): PanelDefaults {
  const obj = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = { ...BUILTIN_PANEL_DEFAULTS };
  for (const { key } of PANEL_TOGGLES) if (typeof obj[key] === 'boolean') out[key] = obj[key] as boolean;
  if (obj.editorMode === 'read' || obj.editorMode === 'editing') out.editorMode = obj.editorMode;
  return out;
}
