import { describe, expect, test } from 'bun:test';
import { appearanceCss, httpFontUrl, isSafeColorSyntax } from './appearance';

const deps = { isColor: isSafeColorSyntax, fontUrl: httpFontUrl };

describe('appearanceCss', () => {
  test('joins the font and colour overrides', () => {
    const css = appearanceCss(
      { colors: { dark: { accent: '#5aa2f0' } }, fonts: { ui: { size: 15, files: ['Inter.woff2'] } } },
      deps,
    );
    expect(css).toContain("font-family: 'Sunstone UI';");
    expect(css).toContain('src: url("/_api/appearance/font?file=Inter.woff2")');
    expect(css).toContain('--font-ui-size: 15px;');
    expect(css).toContain('--accent: #5aa2f0;');
  });

  test('is empty for no or a malformed config', () => {
    expect(appearanceCss(null, deps)).toBe('');
    expect(appearanceCss([], deps)).toBe('');
    expect(appearanceCss({ colors: 'red', fonts: 3 }, deps)).toBe('');
  });
});

describe('isSafeColorSyntax', () => {
  test('passes colour shapes and refuses markup or declaration breaks', () => {
    for (const v of ['#2b7fd9', 'rebeccapurple', 'rgb(1 2 3 / 50%)', 'oklch(0.7 0.1 250)']) {
      expect(isSafeColorSyntax(v)).toBe(true);
    }
    for (const v of ['red; --x: 1', 'red}', '</style>', "url('x')", 'a'.repeat(101)]) {
      expect(isSafeColorSyntax(v)).toBe(false);
    }
  });
});

test('httpFontUrl encodes the whole path into the query', () => {
  expect(httpFontUrl('fonts/a b.woff2')).toBe('/_api/appearance/font?file=fonts%2Fa%20b.woff2');
});
