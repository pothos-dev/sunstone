/**
 * Theme store (slice: config-theme-state-store).
 *
 * Establishes a single source of truth for the app's light/dark theme and
 * applies it as a `data-theme="light"|"dark"` attribute on the APP ROOT element
 * so BOTH the app UI (CSS) and the atomic-editor inside CodeMirror (`cm.ts`
 * reads the inherited `data-theme`) are themed consistently.
 *
 * `mode: 'system'` follows `prefers-color-scheme` and tracks live changes; an
 * explicit `'light'`/`'dark'` forces a scheme. The user's colour overrides from
 * the config store are applied separately by `loadThemeColors` below.
 */

import type { Backend } from '$lib/ipc/backend';
import { parseThemeColors, themeColorsCss } from './themeColors';

/** Theme mode. `'system'` follows the OS; explicit values force a scheme. */
export type ThemeMode = 'system' | 'light' | 'dark';

/** The concrete scheme actually applied to the DOM. */
export type ResolvedTheme = 'light' | 'dark';

function osPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

class ThemeStore {
  /** User/app preference. Only `'system'` ships now; the field is future-proof. */
  mode = $state<ThemeMode>('system');
  /** OS preference, tracked live via matchMedia. */
  #osDark = $state<boolean>(osPrefersDark());

  /** The scheme to actually apply: `mode` when explicit, else the OS setting. */
  resolved = $derived<ResolvedTheme>(
    this.mode === 'system' ? (this.#osDark ? 'dark' : 'light') : this.mode,
  );

  #mql: MediaQueryList | null = null;
  #onChange = (e: MediaQueryListEvent) => {
    this.#osDark = e.matches;
  };

  /**
   * Start tracking the OS color scheme. Returns a teardown fn. Called once from
   * the app shell's `onMount`. Applying the resolved theme to the DOM is the
   * caller's job (an `$effect` reading `theme.resolved`), so the store stays a
   * pure state holder.
   */
  start(): () => void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return () => {};
    }
    this.#mql = window.matchMedia('(prefers-color-scheme: dark)');
    this.#osDark = this.#mql.matches;
    this.#mql.addEventListener('change', this.#onChange);
    return () => {
      this.#mql?.removeEventListener('change', this.#onChange);
      this.#mql = null;
    };
  }
}

export const theme = new ThemeStore();

/**
 * Apply `resolved` to the DOM: `data-theme` on the app `root` (what the app CSS
 * and the CodeMirror editors read) AND on `<html>`, which keeps the DOCUMENT
 * background in step — overscroll/rubber-band, and the pre-hydration paint that
 * `app.html` seeds from the same two rules. Called from each shell's theme
 * `$effect`; `root` may be null before the element is bound.
 */
export function applyTheme(root: HTMLElement | null, resolved: ResolvedTheme): void {
  root?.setAttribute('data-theme', resolved);
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', resolved);
  }
}

/** Id of the `<style>` element carrying the user's colour overrides. */
const THEME_COLORS_STYLE_ID = 'sunstone-theme-colors';

/**
 * Fetch the user's colour overrides and install them as a `<style>` appended to
 * `<head>` — after `app.css`, so its same-specificity rules win, and the tokens
 * derived from the base colours follow. Called once from each desktop shell's
 * `onMount`; a failed load keeps the default palette.
 */
export async function loadThemeColors(backend: Backend): Promise<void> {
  if (typeof document === 'undefined') return;
  let raw: unknown = null;
  try {
    raw = await backend.loadThemeColors();
  } catch {
    return;
  }
  const css = themeColorsCss(parseThemeColors(raw, (v) => CSS.supports('color', v)));
  let style = document.getElementById(THEME_COLORS_STYLE_ID);
  if (css === '') {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement('style');
    style.id = THEME_COLORS_STYLE_ID;
    document.head.append(style);
  }
  style.textContent = css;
}
