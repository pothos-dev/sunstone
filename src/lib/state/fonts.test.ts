import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { FONT_ROLES, fontsCss, isFontFamily, parseFonts } from './fonts';

const url = (src: string) => `/f/${src}`;

describe('isFontFamily', () => {
  test('accepts name lists with quoted and unquoted names', () => {
    for (const v of ['Inter', 'Inter, sans-serif', "'Noto Sans JP', serif", '"Fira Code",monospace', 'Source Code Pro']) {
      expect(isFontFamily(v)).toBe(true);
    }
  });

  test('refuses anything that could leave the declaration or the <style>', () => {
    for (const v of [
      'Inter; --x: 1',
      'Inter}',
      "'a</style><script>'",
      "'a;b'",
      'url(x)',
      'Inter,',
      '',
      "'unterminated",
      '3270',
      'a'.repeat(501),
    ]) {
      expect(isFontFamily(v)).toBe(false);
    }
  });
});

describe('parseFonts', () => {
  test('keeps valid fields per role and drops the rest', () => {
    const fonts = parseFonts({
      ui: { family: ' Inter, sans-serif ', size: 15, files: ['Inter.woff2'] },
      content: { family: 'bad;', size: 100 },
      code: {
        size: 0.85,
        files: [
          { src: 'fonts/Mono-Bold.ttf', weight: 700, style: 'italic' },
          { src: 'fonts/Mono.otf', weight: '100 900', style: 'slanted' },
          '../escape.woff2',
          '.hidden/x.woff2',
          '/abs.woff2',
          'notes.txt',
          'q"uote.woff2',
          3,
        ],
      },
      extra: { family: 'Inter' },
    });
    expect(fonts).toEqual({
      ui: { family: 'Inter, sans-serif', size: 15, files: [{ src: 'Inter.woff2' }] },
      code: {
        size: 0.85,
        files: [
          { src: 'fonts/Mono-Bold.ttf', weight: '700', style: 'italic' },
          { src: 'fonts/Mono.otf', weight: '100 900' },
        ],
      },
    });
  });

  test('enforces each role size range', () => {
    expect(parseFonts({ ui: { size: 7 } })).toEqual({});
    expect(parseFonts({ ui: { size: 32 } }).ui?.size).toBe(32);
    expect(parseFonts({ content: { size: 48 } }).content?.size).toBe(48);
    expect(parseFonts({ code: { size: 3 } })).toEqual({});
    expect(parseFonts({ code: { size: '0.9' } })).toEqual({});
  });

  test('tolerates a missing or malformed value', () => {
    expect(parseFonts(null)).toEqual({});
    expect(parseFonts([])).toEqual({});
    expect(parseFonts({ ui: 'Inter', content: [] })).toEqual({});
  });
});

describe('fontsCss', () => {
  test('is empty when nothing is set', () => {
    expect(fontsCss({}, url)).toBe('');
  });

  test('emits the role tokens on :root, with no private face when there are no files', () => {
    const css = fontsCss(parseFonts({ ui: { family: 'Inter', size: 15 }, code: { size: 0.8 } }), url);
    expect(css).toBe(":root {\n  --font-ui: Inter;\n  --font-ui-size: 15px;\n  --font-code-scale: 0.8;\n}\n");
  });

  test('puts the private face in front only when the role has files', () => {
    const css = fontsCss(parseFonts({ ui: { family: 'Inter', files: ['i.woff2'] }, content: { files: ['c.woff2'] } }), url);
    expect(css).toContain("  --font-ui: 'Sunstone UI', Inter;\n");
    expect(css).toContain(`  --font-content: 'Sunstone Content', ${FONT_ROLES.content.stack};\n`);
  });

  test("each role's default stack matches app.css, which names no private face", () => {
    const appCss = readFileSync(new URL('../../app.css', import.meta.url), 'utf8');
    for (const spec of Object.values(FONT_ROLES)) {
      expect(appCss).toContain(`  ${spec.family}: ${spec.stack};\n`);
    }
    expect(appCss).not.toMatch(/--font-(ui|content|mono):[^;]*Sunstone/);
  });

  test('registers each file under the role face, with its descriptors', () => {
    const css = fontsCss(
      parseFonts({ content: { files: [{ src: 'a b.woff2', weight: '100 900', style: 'italic' }, 'c.ttf'] } }),
      (src) => `/font?file=${encodeURIComponent(src)}`,
    );
    expect(css).toBe(
      "@font-face {\n  font-family: 'Sunstone Content';\n  src: url(\"/font?file=a%20b.woff2\") format('woff2');\n" +
        '  font-weight: 100 900;\n  font-style: italic;\n  font-display: swap;\n}\n' +
        "@font-face {\n  font-family: 'Sunstone Content';\n  src: url(\"/font?file=c.ttf\") format('truetype');\n" +
        '  font-display: swap;\n}\n' +
        `:root {\n  --font-content: 'Sunstone Content', ${FONT_ROLES.content.stack};\n}\n`,
    );
  });
});
