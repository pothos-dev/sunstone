// Mermaid Diagram theming — PURE, DOM- and CodeMirror-free.
//
// Mermaid's renderer input: the token→mermaid-variable mapping that themes a
// Diagram with the app palette. Used by the mermaid language
// (`mermaidLanguage.ts`) on every surface the diagram seam renders on (the
// editor field and the web/print island). `ResolvedTheme` / `CssVarReader`
// are the seam's own types, re-exported here for existing importers.

import type { CssVarReader, ResolvedTheme } from './diagramLanguage';

export type { CssVarReader, ResolvedTheme } from './diagramLanguage';

/** The mermaid init config (subset) that themes a Diagram with the app palette. */
export interface MermaidThemeConfig {
  /** Always mermaid's `base` theme — the only one whose colours are fully overridable. */
  readonly theme: 'base';
  /** Top-level font (mermaid also reads `themeVariables.fontFamily`). */
  readonly fontFamily: string;
  readonly themeVariables: Record<string, string | boolean>;
}

/**
 * Build the mermaid init config that themes a Diagram with Sunstone's OWN
 * palette and font, instead of mermaid's generic `dark`/`default` themes (which
 * ship their own colours and font — the cause of the white-block/black-text/
 * wrong-font look in dark mode). We use mermaid's `base` theme and override its
 * `themeVariables` with CONCRETE values resolved from the app's CSS custom
 * properties (read off the themed root), so a Diagram reads as part of the app
 * in both light and dark (ADR-0005, theme-sync):
 *   - node fill   = surface background  (`--bg-elevated`)
 *   - node border = foreground          (`--text`)
 *   - node text   = foreground          (`--text`)
 *   - edges       = muted foreground    (`--text-muted`)
 *   - font        = app UI font         (`--font-ui`)
 *
 * Concrete values (not `var(--x)`) are required because mermaid bakes colours
 * into the SVG at render time. Pure: the impure `getComputedStyle` read is
 * INJECTED as `read`, so the token→mermaid-variable mapping is unit-testable.
 */
export function mermaidThemeConfig(read: CssVarReader, resolved: ResolvedTheme): MermaidThemeConfig {
  const bg = read('--bg');
  const surface = read('--bg-elevated');
  const sunken = read('--bg-sunken');
  const fg = read('--text');
  const muted = read('--text-muted');
  const border = read('--border-strong');
  const accent = read('--accent');
  const font = read('--font-ui');
  return {
    theme: 'base',
    fontFamily: font,
    themeVariables: {
      // Help mermaid derive any colours we don't set explicitly.
      darkMode: resolved === 'dark',
      background: bg,
      fontFamily: font,
      // Primary = flowchart nodes: surface fill, foreground border + text.
      primaryColor: surface,
      primaryBorderColor: fg,
      primaryTextColor: fg,
      mainBkg: surface,
      nodeBorder: fg,
      nodeTextColor: fg,
      // Edges / arrows and their labels.
      lineColor: muted,
      edgeLabelBackground: bg,
      // Clusters / subgraphs.
      clusterBkg: sunken,
      clusterBorder: border,
      // Secondary / tertiary surfaces mermaid derives other shapes from.
      secondaryColor: sunken,
      secondaryBorderColor: border,
      secondaryTextColor: fg,
      tertiaryColor: bg,
      tertiaryBorderColor: border,
      tertiaryTextColor: fg,
      // General label / title text.
      textColor: fg,
      titleColor: fg,
      // Notes pick up the accent so they stand out without leaving the palette.
      noteBkgColor: surface,
      noteTextColor: fg,
      noteBorderColor: accent,
    },
  };
}

/**
 * Mermaid's `(source, theme)` identity: a baked mermaid SVG depends on BOTH the
 * source and the resolved theme (mermaid bakes colours in at render time). The
 * seam's render cache keys on `diagramCacheKey` (`diagramLanguage.ts`), which
 * adds the language in front of this same pair. The theme is a fixed
 * `'light'|'dark'` token with no spaces, so a space-delimited prefix can never
 * collide with source text.
 */
export function mermaidCacheKey(source: string, theme: ResolvedTheme): string {
  return `${theme} ${source}`;
}
