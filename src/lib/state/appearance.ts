/**
 * The user's appearance config — `colors` (`themeColors.ts`) and `fonts`
 * (`fonts.ts`) — turned into the ONE override stylesheet both shells apply
 * after `app.css` (pure logic; installed by `state/theme.svelte.ts`, and on the
 * web also inlined by the SSR hook so the first paint already has it).
 */

import { fontsCss, parseFonts } from './fonts';
import { parseThemeColors, themeColorsCss } from './themeColors';

/** Id of the `<style>` element carrying the overrides (SSR and client share it). */
export const APPEARANCE_STYLE_ID = 'sunstone-appearance';

export interface AppearanceDeps {
  /** Whether a colour value is valid CSS (`CSS.supports('color', v)` in a browser). */
  isColor: (value: string) => boolean;
  /** The URL a config-relative font file is served at (`Backend.fontUrl`). */
  fontUrl: (src: string) => string;
}

/** The override stylesheet for the raw `{ colors?, fonts? }` value, or `''`. */
export function appearanceCss(raw: unknown, deps: AppearanceDeps): string {
  const obj = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return (
    fontsCss(parseFonts(obj.fonts), deps.fontUrl) + themeColorsCss(parseThemeColors(obj.colors, deps.isColor))
  );
}

/**
 * A DOM-free colour check for the SSR pass: only characters a colour value
 * (`#hex`, `rgb(…)`, `oklch(…)`, a name) can contain, so nothing can end the
 * declaration or the `<style>`. Looser than `CSS.supports`; the client re-applies
 * the stylesheet with the real check right after hydration.
 */
export function isSafeColorSyntax(value: string): boolean {
  return value.length <= 100 && /^[#A-Za-z0-9(),.%\s/+-]+$/.test(value);
}

/** Where Sunstone Web (and `sunstone serve`) serves a config-relative font file. */
export function httpFontUrl(src: string): string {
  return `/_api/appearance/font?file=${encodeURIComponent(src)}`;
}
