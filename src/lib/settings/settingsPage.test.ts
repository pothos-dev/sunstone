import { describe, expect, test } from 'bun:test';
import { DEFAULT_KEYBINDINGS, resolveKeybindings } from './keybindings';
import { clampFontSize, filterCommands, FONT_ROLE_META } from './settingsPage';

describe('clampFontSize', () => {
  const ui = FONT_ROLE_META.ui.size!;
  const code = FONT_ROLE_META.code.size!;

  test('keeps an in-range size', () => {
    expect(clampFontSize(ui, 15)).toBe(15);
  });

  test('clamps to the role range from fonts.ts', () => {
    expect(clampFontSize(ui, 2)).toBe(8);
    expect(clampFontSize(ui, 99)).toBe(32);
    expect(clampFontSize(code, 9)).toBe(2);
  });

  test('rounds to the step without float noise', () => {
    expect(clampFontSize(code, 0.87)).toBe(0.85);
    expect(clampFontSize(code, 0.85 + 0.05)).toBe(0.9);
  });

  test('refuses what is not a number', () => {
    expect(clampFontSize(ui, Number.NaN)).toBeNull();
  });

  test('headings have no size', () => {
    expect(FONT_ROLE_META.heading.size).toBeNull();
  });
});

describe('filterCommands', () => {
  test('an empty query lists every command', () => {
    expect(filterCommands('  ', DEFAULT_KEYBINDINGS, false).length).toBeGreaterThan(10);
  });

  test('matches labels case-insensitively', () => {
    expect(filterCommands('BOLD', DEFAULT_KEYBINDINGS, false).map((c) => c.id)).toEqual(['bold']);
  });

  test('matches the shortcut through its key caps', () => {
    expect(filterCommands('ctrl k', DEFAULT_KEYBINDINGS, false).map((c) => c.id)).toEqual(['quickNav']);
  });

  test('follows a rebinding', () => {
    const bindings = resolveKeybindings({ quickNav: 'Mod-j' });
    expect(filterCommands('ctrl j', bindings, false).map((c) => c.id)).toEqual(['quickNav']);
  });
});
