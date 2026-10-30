import { describe, expect, test } from 'bun:test';
import type { ConfigEdit } from '$lib/types';
import { applyConfigEdits, configValue, isSettingsPath, planEdit, withEdit, withoutWritten } from './configEdits';

// Mirrors the cases in `crates/sunstone-native/src/settings.rs`: the Rust write
// and this apply (preview + fake backend) must agree.

const set = (path: string[], value: unknown): ConfigEdit => ({ path, value });
const unset = (path: string[]): ConfigEdit => ({ path });

const handWritten = () => ({
  $comment: 'mine',
  fonts: { code: { family: 'JetBrains Mono', files: ['JBM.woff2'] } },
  colors: { dark: { accent: '#5aa2f0' } },
  'x-tool': { z: 1, a: 2 },
});

describe('applyConfigEdits', () => {
  test('unrelated keys and their order survive; new keys append', () => {
    const out = applyConfigEdits(handWritten(), [set(['theme'], 'dark')]);
    expect(Object.keys(out)).toEqual(['$comment', 'fonts', 'colors', 'x-tool', 'theme']);
    expect(Object.keys(out['x-tool'] as object)).toEqual(['z', 'a']);
    expect(out.$comment).toBe('mine');
  });

  test('editing a family keeps its font files', () => {
    const out = applyConfigEdits(handWritten(), [set(['fonts', 'code', 'family'], 'Fira Code')]);
    expect(out.fonts).toEqual({ code: { family: 'Fira Code', files: ['JBM.woff2'] } });
  });

  test('a removal prunes only the objects it emptied', () => {
    expect(applyConfigEdits(handWritten(), [unset(['colors', 'dark', 'accent'])]).colors).toBeUndefined();
    expect(applyConfigEdits(handWritten(), [unset(['fonts', 'code', 'family'])]).fonts).toEqual({
      code: { files: ['JBM.woff2'] },
    });
    const out = applyConfigEdits({ defaults: {}, keybindings: { bold: 'Mod-b' } }, [
      unset(['keybindings', 'bold']),
      unset(['defaults', 'tags']),
    ]);
    expect(out).toEqual({ defaults: {} });
  });

  test('a set creates parents and replaces a non-object in the way', () => {
    expect(applyConfigEdits({ fonts: 3 }, [set(['fonts', 'ui', 'size'], 15)])).toEqual({ fonts: { ui: { size: 15 } } });
  });

  test('null is a value, not a removal', () => {
    expect(applyConfigEdits(null, [set(['keybindings', 'paragraph'], null)])).toEqual({ keybindings: { paragraph: null } });
  });

  test('removing something absent is a no-op', () => {
    expect(applyConfigEdits(handWritten(), [unset(['defaults', 'tags']), unset(['theme'])])).toEqual(handWritten());
  });

  test('the input is not mutated', () => {
    const input = handWritten();
    applyConfigEdits(input, [set(['fonts', 'code', 'family'], 'X'), unset(['colors', 'dark', 'accent'])]);
    expect(input).toEqual(handWritten());
  });
});

describe('isSettingsPath', () => {
  test('only non-empty paths under the settings keys', () => {
    expect(isSettingsPath(['theme'])).toBe(true);
    expect(isSettingsPath(['fonts', 'ui', 'size'])).toBe(true);
    expect(isSettingsPath([])).toBe(false);
    expect(isSettingsPath(['x-tool', 'z'])).toBe(false);
    expect(isSettingsPath(['$comment'])).toBe(false);
    expect(isSettingsPath(['fonts', '', 'size'])).toBe(false);
  });
});

describe('configValue', () => {
  test('walks objects and stops at anything else', () => {
    expect(configValue(handWritten(), ['fonts', 'code', 'family'])).toBe('JetBrains Mono');
    expect(configValue(handWritten(), ['fonts', 'code', 'files', '0'])).toBeUndefined();
    expect(configValue(null, ['theme'])).toBeUndefined();
  });
});

describe('planEdit', () => {
  const base = { theme: 'dark', fonts: { ui: { size: 15 } } };

  test('a value the file already holds writes nothing', () => {
    expect(planEdit(base, ['theme'], { value: 'dark' })).toBeNull();
    expect(planEdit(base, ['theme'], { value: 'light' })).toEqual({ path: ['theme'], value: 'light' });
  });

  test('resetting an absent key writes nothing', () => {
    expect(planEdit(base, ['colorTheme'], 'reset')).toBeNull();
    expect(planEdit(base, ['fonts', 'ui', 'size'], 'reset')).toEqual({ path: ['fonts', 'ui', 'size'] });
  });

  test('null is a value (an unbound shortcut), not a reset', () => {
    expect(planEdit({}, ['keybindings', 'bold'], { value: null })).toEqual({ path: ['keybindings', 'bold'], value: null });
  });
});

describe('pending edits across a write', () => {
  test('an edit replaced during the write stays pending', () => {
    const dark = { path: ['theme'], value: 'dark' };
    const batch = withEdit(new Map(), ['theme'], dark);
    // While `dark` is written, the user picks light again: judged against the
    // file as it will be (dark), so it is recorded rather than dropped.
    const planned = planEdit(applyConfigEdits({}, [dark]), ['theme'], { value: 'light' });
    const pending = withEdit(batch, ['theme'], planned);
    expect(withoutWritten(pending, batch).get('theme')).toEqual({ path: ['theme'], value: 'light' });
  });

  test('a written edit leaves', () => {
    const batch = withEdit(new Map(), ['theme'], { path: ['theme'], value: 'dark' });
    expect(withoutWritten(batch, batch).size).toBe(0);
  });
});
