/**
 * User colour overrides (pure logic; applied by `state/theme.svelte.ts`).
 *
 * The palette in `app.css` rests on twelve BASE colours per scheme; every other
 * colour token is derived from them with `color-mix()`. The user can override
 * any base colour, per scheme, by hand in the desktop config store
 * (`~/.config/sunstone/state.json`):
 *
 *   { "config": { "colors": {
 *       "light": { "accent": "#2b7fd9", "bg": "#f4f7fb" },
 *       "dark":  { "accent": "#5aa2f0" } } } }
 *
 * Rust hands `config.colors` over as opaque JSON; this module keeps only the
 * known keys whose values are valid CSS colours and turns them into one
 * stylesheet that re-declares those tokens after `app.css`.
 */

/** Config key → the CSS custom property it overrides. */
export const BASE_COLORS = {
  bg: '--bg',
  bgElevated: '--bg-elevated',
  bgSunken: '--bg-sunken',
  text: '--text',
  textMuted: '--text-muted',
  textFaint: '--text-faint',
  border: '--border',
  borderStrong: '--border-strong',
  accent: '--accent',
  accentContrast: '--accent-contrast',
  danger: '--danger',
  tagText: '--tag-text',
} as const;

export type BaseColor = keyof typeof BASE_COLORS;
export type ColorOverrides = Partial<Record<BaseColor, string>>;
export interface ThemeColors {
  light: ColorOverrides;
  dark: ColorOverrides;
}

/**
 * Selectors for each scheme's override rule. Dark matches `app.css`'s dark
 * block exactly. Light must NOT use `:root`: `<html>` carries `data-theme`, so
 * in dark mode it matches both `:root` and `[data-theme='dark']`, and a later
 * `:root` rule would beat the dark defaults for any key only the light scheme
 * overrides. `:root:not([data-theme])` still covers the pre-theme first paint.
 */
const SELECTORS = {
  light: ":root:not([data-theme]),\n[data-theme='light']",
  dark: "[data-theme='dark'],\nbody:has([data-theme='dark'])",
} as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseScheme(raw: unknown, isColor: (value: string) => boolean): ColorOverrides {
  const out: ColorOverrides = {};
  if (!isRecord(raw)) return out;
  for (const key of Object.keys(BASE_COLORS) as BaseColor[]) {
    const value = raw[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed !== '' && isColor(trimmed)) out[key] = trimmed;
  }
  return out;
}

/**
 * Parse the opaque `config.colors` value. Unknown keys, non-strings and values
 * `isColor` rejects are dropped (the browser passes `CSS.supports('color', v)`,
 * which also refuses anything that could break out of the declaration).
 */
export function parseThemeColors(raw: unknown, isColor: (value: string) => boolean): ThemeColors {
  const obj = isRecord(raw) ? raw : {};
  return { light: parseScheme(obj.light, isColor), dark: parseScheme(obj.dark, isColor) };
}

/** The override stylesheet, or `''` when nothing is overridden. */
export function themeColorsCss(colors: ThemeColors): string {
  return (['light', 'dark'] as const)
    .map((scheme) => {
      const entries = Object.entries(colors[scheme]) as [BaseColor, string][];
      if (entries.length === 0) return '';
      const decls = entries.map(([key, value]) => `  ${BASE_COLORS[key]}: ${value};`).join('\n');
      return `${SELECTORS[scheme]} {\n${decls}\n}\n`;
    })
    .join('');
}
