// PlantUML Diagram theming — PURE, DOM- and CodeMirror-free (dr-4, ADR-0016).
//
// PlantUML bakes literal colours into its SVG (`fill="#F1F1F1"`) and has no
// classes to restyle, so it is themed the way mermaid is: at render time, with
// concrete values resolved from the app's CSS custom properties. The values go
// in a PlantUML `<style>` block that `plantumlEngine.ts` inserts right after
// the source's `@start…` line. Anything the author writes later in the source
// (a `skinparam`, a `!theme`, their own `<style>`, `#colour` on an element)
// comes after ours and wins, so authored colours stay as written.
//
// The mapping mirrors `mermaidTheme.ts`, so the languages read as one family:
// surface fills, foreground borders and labels, muted edges, sunken containers
// with a strong-border outline, notes on the surface with an accent border.

import type { CssVarReader } from './diagramLanguage';

/** An opaque colour as PlantUML takes it, `#RRGGBB`. */
type Hex = `#${string}`;

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseHex(value: string): Rgba | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
  if (!m) return null;
  let digits = m[1];
  if (digits.length <= 4) digits = [...digits].map((d) => d + d).join('');
  const n = (i: number) => parseInt(digits.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: digits.length === 8 ? n(6) / 255 : 1 };
}

function parseRgbFunction(value: string): Rgba | null {
  const m = /^rgba?\(\s*([^)]*)\)$/i.exec(value);
  if (!m) return null;
  // Both `rgb(1, 2, 3, 0.5)` and `rgb(1 2 3 / 50%)`.
  const parts = m[1].split(/\s*[,/]\s*|\s+/).filter((p) => p !== '');
  if (parts.length < 3 || parts.length > 4) return null;
  const channel = (p: string) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
  const alpha = (p: string) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p));
  const [r, g, b] = parts.slice(0, 3).map(channel);
  const a = parts.length === 4 ? alpha(parts[3]) : 1;
  if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
  return { r, g, b, a: Math.min(1, Math.max(0, a)) };
}

function toHex({ r, g, b }: Rgba): Hex {
  const byte = (n: number) =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`.toUpperCase() as Hex;
}

/**
 * A CSS colour (`#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`) as an opaque
 * `#RRGGBB`, a translucent one composited over `backdrop`. The app's dark
 * palette has translucent borders; PlantUML takes only plain hex. Any other
 * form (a named colour, `color-mix()`) gives `null`, and the caller leaves that
 * property to PlantUML's default.
 */
export function cssColorToHex(value: string, backdrop: Hex = '#FFFFFF'): Hex | null {
  const v = value.trim();
  const colour = parseHex(v) ?? parseRgbFunction(v);
  if (!colour) return null;
  if (colour.a >= 1) return toHex(colour);
  const under = parseHex(backdrop) ?? { r: 255, g: 255, b: 255, a: 1 };
  const mix = (top: number, bottom: number) => top * colour.a + bottom * (1 - colour.a);
  return toHex({
    r: mix(colour.r, under.r),
    g: mix(colour.g, under.g),
    b: mix(colour.b, under.b),
    a: 1,
  });
}

/**
 * A CSS `font-family` list as a PlantUML `FontName` value: quotes dropped,
 * since PlantUML copies the value into the SVG and into the canvas font it
 * measures text with, and both read an unquoted list.
 */
export function plantumlFontName(fontFamily: string): string {
  return fontFamily.replace(/["']/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * PlantUML style selectors for things that group other elements. They take
 * mermaid's cluster look: a sunken fill with a strong-border outline.
 */
export const PLANTUML_CONTAINERS = [
  'package',
  'node',
  'frame',
  'folder',
  'cloud',
  'rectangle',
  'group',
  'partition',
] as const;

/**
 * The `<style>` block that themes a PlantUML Diagram with the app palette and
 * font, one line per entry, resolved through `read` (the impure
 * `getComputedStyle` read, injected so the mapping is unit-testable). A token
 * that does not resolve to a colour PlantUML can take is left out, and that
 * property keeps PlantUML's default.
 */
export function plantumlStylePreamble(read: CssVarReader): string[] {
  const surface = cssColorToHex(read('--bg-elevated')) ?? '#FFFFFF';
  const colour = (name: string) => cssColorToHex(read(name), surface);
  const fg = colour('--text');
  const muted = colour('--text-muted');
  const sunken = colour('--bg-sunken');
  const border = colour('--border-strong');
  const accent = colour('--accent');
  const font = plantumlFontName(read('--font-ui'));

  const rule = (selector: string, declarations: [string, string | null][]): string[] => {
    const body = declarations
      .filter((d): d is [string, string] => d[1] !== null && d[1] !== '')
      .map(([property, value]) => `  ${property} ${value}`);
    return body.length > 0 ? [`${selector} {`, ...body, '}'] : [];
  };

  return [
    '<style>',
    ...rule('root', [
      ['FontName', font],
      ['FontColor', fg],
      ['LineColor', fg],
      ['BackGroundColor', surface],
    ]),
    // The diagram sits on the page (the editor's paper, the printed sheet).
    ...rule('document', [['BackGroundColor', 'transparent']]),
    ...rule('arrow', [
      ['LineColor', muted],
      ['FontColor', muted],
    ]),
    ...rule('note', [
      ['BackGroundColor', surface],
      ['LineColor', accent],
    ]),
    ...rule(PLANTUML_CONTAINERS.join(', '), [
      ['BackGroundColor', sunken],
      ['LineColor', border],
    ]),
    '</style>',
  ];
}
