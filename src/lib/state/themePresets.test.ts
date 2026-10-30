import { describe, expect, test } from 'bun:test';
import { appearanceCss } from './appearance';
import { BASE_COLORS } from './themeColors';
import { DEFAULT_PRESET_ID, presetById, THEME_PRESETS, withPreset } from './themePresets';

const deps = { isColor: () => true, fontUrl: (src: string) => `/f/${src}` };

describe('THEME_PRESETS', () => {
  test('every preset sets all twelve base colours as hex for both schemes', () => {
    for (const t of THEME_PRESETS) {
      for (const scheme of ['light', 'dark'] as const) {
        expect(Object.keys(t[scheme]).sort()).toEqual(Object.keys(BASE_COLORS).sort());
        for (const v of Object.values(t[scheme])) expect(v).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  test('ids are unique and Sunstone comes first', () => {
    expect(new Set(THEME_PRESETS.map((t) => t.id)).size).toBe(THEME_PRESETS.length);
    expect(THEME_PRESETS[0].id).toBe(DEFAULT_PRESET_ID);
    expect(presetById('nope').id).toBe(DEFAULT_PRESET_ID);
  });
});

describe('withPreset', () => {
  const empty = { light: {}, dark: {} };

  test('Sunstone and unknown ids add nothing', () => {
    expect(withPreset(DEFAULT_PRESET_ID, empty)).toEqual(empty);
    expect(withPreset('nope', empty)).toEqual(empty);
    expect(withPreset(undefined, empty)).toEqual(empty);
  });

  test("a user's own colour wins over the preset's", () => {
    const out = withPreset('nord', { light: {}, dark: { accent: '#ff0000' } });
    expect(out.dark.accent).toBe('#ff0000');
    expect(out.dark.bg).toBe(presetById('nord').dark.bg);
    expect(out.light.accent).toBe(presetById('nord').light.accent);
  });
});

describe('appearanceCss with colorTheme', () => {
  test('a preset emits both schemes', () => {
    const css = appearanceCss({ colorTheme: 'gruvbox' }, deps);
    expect(css).toContain(`--bg: ${presetById('gruvbox').light.bg};`);
    expect(css).toContain(`--bg: ${presetById('gruvbox').dark.bg};`);
  });

  test('Sunstone emits nothing', () => {
    expect(appearanceCss({ colorTheme: DEFAULT_PRESET_ID }, deps)).toBe('');
  });
});
