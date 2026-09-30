import { describe, expect, test } from 'bun:test';
import { parseThemeColors, themeColorsCss } from './themeColors';

const anyColor = (v: string) => !v.includes(';') && !v.includes('}');

describe('parseThemeColors', () => {
  test('keeps known keys with valid string values, per scheme', () => {
    const colors = parseThemeColors(
      {
        light: { accent: ' #2b7fd9 ', bgElevated: 'white', typo: '#000', text: 3, danger: '' },
        dark: { accent: 'red; --x: 1', tagText: 'rgb(1 2 3)' },
      },
      anyColor,
    );
    expect(colors).toEqual({
      light: { accent: '#2b7fd9', bgElevated: 'white' },
      dark: { tagText: 'rgb(1 2 3)' },
    });
  });

  test('tolerates a missing or malformed value', () => {
    const empty = { light: {}, dark: {} };
    expect(parseThemeColors(null, anyColor)).toEqual(empty);
    expect(parseThemeColors([], anyColor)).toEqual(empty);
    expect(parseThemeColors({ light: 'blue', dark: [] }, anyColor)).toEqual(empty);
  });
});

describe('themeColorsCss', () => {
  test('is empty when nothing is overridden', () => {
    expect(themeColorsCss({ light: {}, dark: {} })).toBe('');
  });

  test('emits one rule per overridden scheme with the CSS property names', () => {
    const css = themeColorsCss({ light: {}, dark: { accent: '#5aa2f0', bgSunken: '#000' } });
    expect(css).toBe(
      "[data-theme='dark'],\nbody:has([data-theme='dark']) {\n  --accent: #5aa2f0;\n  --bg-sunken: #000;\n}\n",
    );
  });

  test("the light rule never matches a dark-themed <html> via :root", () => {
    const css = themeColorsCss({ light: { accent: '#123' }, dark: {} });
    expect(css).toContain(":root:not([data-theme]),\n[data-theme='light'] {");
  });
});
