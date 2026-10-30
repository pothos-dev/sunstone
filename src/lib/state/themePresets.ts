/**
 * Colour themes the settings page offers (pure logic). A theme is a full set
 * of the twelve base colours (`themeColors.ts`) for each scheme; picking one
 * writes only its id (`"colorTheme": "nord"`) to `config.json`, and any
 * per-colour `colors` override still wins over it (`withPreset`). Sunstone is
 * `app.css` itself: choosing it removes the key and emits no colours.
 */

import type { BaseColor, ThemeColors } from './themeColors';

export type Palette = Record<BaseColor, string>;

export interface ThemePreset {
  id: string;
  name: string;
  light: Palette;
  dark: Palette;
}

export const DEFAULT_PRESET_ID = 'sunstone';

// Argument order follows `BASE_COLORS`.
function p(...v: [string, string, string, string, string, string, string, string, string, string, string, string]): Palette {
  const [bg, bgElevated, bgSunken, text, textMuted, textFaint, border, borderStrong, accent, accentContrast, danger, tagText] = v;
  return { bg, bgElevated, bgSunken, text, textMuted, textFaint, border, borderStrong, accent, accentContrast, danger, tagText };
}

export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: DEFAULT_PRESET_ID,
    name: 'Sunstone',
    // `app.css`'s values, for the picker's swatches only (the dark borders
    // there are translucent; these are their look over the dark background).
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

/** The preset `id` names, or Sunstone for anything unknown. */
export function presetById(id: unknown): ThemePreset {
  return THEME_PRESETS.find((t) => t.id === id) ?? THEME_PRESETS[0];
}

/**
 * The colours to override: the preset's (none for Sunstone or an unknown id),
 * with the user's own per-colour overrides on top.
 */
export function withPreset(colorTheme: unknown, colors: ThemeColors): ThemeColors {
  const preset = THEME_PRESETS.find((t) => t.id === colorTheme && t.id !== DEFAULT_PRESET_ID);
  if (!preset) return colors;
  return { light: { ...preset.light, ...colors.light }, dark: { ...preset.dark, ...colors.dark } };
}
