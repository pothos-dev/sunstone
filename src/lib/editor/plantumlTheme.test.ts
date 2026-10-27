// Unit tests for the PlantUML palette preamble (dr-4).
import { describe, expect, test } from 'bun:test';
import { cssColorToHex, plantumlFontName, plantumlStylePreamble } from './plantumlTheme';

describe('cssColorToHex', () => {
  test('passes opaque hex through, upper-cased and expanded', () => {
    expect(cssColorToHex('#3a2a20')).toBe('#3A2A20');
    expect(cssColorToHex(' #fff ')).toBe('#FFFFFF');
    expect(cssColorToHex('#777')).toBe('#777777');
  });

  test('reads rgb() in comma and space syntax', () => {
    expect(cssColorToHex('rgb(255, 0, 16)')).toBe('#FF0010');
    expect(cssColorToHex('rgb(255 0 16)')).toBe('#FF0010');
  });

  test('composites a translucent colour over the backdrop', () => {
    // 50% white over black is mid grey.
    expect(cssColorToHex('rgba(255, 255, 255, 0.5)', '#000000')).toBe('#808080');
    expect(cssColorToHex('rgb(255 255 255 / 50%)', '#000000')).toBe('#808080');
    expect(cssColorToHex('#ffffff80', '#000000')).toBe('#808080');
    // The dark palette's border over its surface.
    expect(cssColorToHex('rgba(210, 160, 120, 0.24)', '#271C16')).toBe('#503C2E');
  });

  test('null for what PlantUML cannot take', () => {
    expect(cssColorToHex('')).toBeNull();
    expect(cssColorToHex('red')).toBeNull();
    expect(cssColorToHex('color-mix(in srgb, red 50%, blue)')).toBeNull();
    expect(cssColorToHex('#12')).toBeNull();
  });
});

test('plantumlFontName drops the quotes from a font-family list', () => {
  expect(plantumlFontName(`'Jost Variable', "Jost", system-ui,  sans-serif`)).toBe(
    'Jost Variable, Jost, system-ui, sans-serif',
  );
});

describe('plantumlStylePreamble', () => {
  const light: Record<string, string> = {
    '--bg-elevated': '#fffaf4',
    '--bg-sunken': '#f6e4d5',
    '--text': '#3a2a20',
    '--text-muted': '#8a6c58',
    '--border-strong': '#ddbda4',
    '--accent': '#d9622b',
    '--font-ui': "'Jost Variable', system-ui, sans-serif",
  };

  test('maps the app palette onto PlantUML styles, in a <style> block', () => {
    const lines = plantumlStylePreamble((name) => light[name] ?? '');
    expect(lines[0]).toBe('<style>');
    expect(lines.at(-1)).toBe('</style>');
    const text = lines.join('\n');
    expect(text).toContain('root {\n  FontName Jost Variable, system-ui, sans-serif\n  FontColor #3A2A20\n  LineColor #3A2A20\n  BackGroundColor #FFFAF4\n}');
    expect(text).toContain('document {\n  BackGroundColor transparent\n}');
    expect(text).toContain('arrow {\n  LineColor #8A6C58\n  FontColor #8A6C58\n}');
    expect(text).toContain('note {\n  BackGroundColor #FFFAF4\n  LineColor #D9622B\n}');
    expect(text).toMatch(/package, node, .* \{\n {2}BackGroundColor #F6E4D5\n {2}LineColor #DDBDA4\n\}/);
  });

  test('composites translucent tokens over the surface', () => {
    const dark: Record<string, string> = {
      ...light,
      '--bg-elevated': '#271c16',
      '--border-strong': 'rgba(210, 160, 120, 0.24)',
    };
    const text = plantumlStylePreamble((name) => dark[name] ?? '').join('\n');
    expect(text).toContain('LineColor #503C2E');
  });

  test('leaves out what does not resolve, and never emits an empty rule', () => {
    const text = plantumlStylePreamble(() => '').join('\n');
    // The surface falls back to white; nothing else resolves.
    expect(text).toContain('root {\n  BackGroundColor #FFFFFF\n}');
    expect(text).not.toContain('arrow {');
    expect(text).not.toContain('FontName');
  });
});
