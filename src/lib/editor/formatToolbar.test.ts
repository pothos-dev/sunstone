// Unit tests for the formatting Toolbar's control model (aa-1): hotkey labels,
// tooltips, the roving-focus keys, and that every hotkey the Toolbar teaches is
// one the editor's keymap actually binds.
import { describe, expect, test } from 'bun:test';
import {
  controlTitle,
  HEADING_LEVELS,
  headingValue,
  hotkeyLabel,
  INLINE_CONTROLS,
  isToolbarFocusKey,
  linkLabel,
  rovingIndex,
} from './formatToolbar';
import { formattingKeymap } from './formattingKeymap';
import { NO_FORMAT } from './formatState';

describe('hotkeyLabel / controlTitle', () => {
  test('renders Mod as Ctrl, or Cmd on macOS', () => {
    expect(hotkeyLabel('Mod-b', false)).toBe('Ctrl+B');
    expect(hotkeyLabel('Mod-b', true)).toBe('Cmd+B');
    expect(hotkeyLabel('Mod-Shift-m', false)).toBe('Ctrl+Shift+M');
    expect(hotkeyLabel('Mod-0', false)).toBe('Ctrl+0');
  });

  test('a tooltip carries the hotkey when there is one', () => {
    expect(controlTitle('Bold', 'Mod-b', false)).toBe('Bold (Ctrl+B)');
    expect(controlTitle('Insert link', null, false)).toBe('Insert link');
  });
});

describe('the Toolbar teaches the real keymap', () => {
  const bound = new Set(formattingKeymap.map((b) => b.key));
  test('every inline control hotkey is bound in formattingKeymap', () => {
    for (const c of INLINE_CONTROLS) expect(bound.has(c.key)).toBe(true);
  });
  test('every heading choice hotkey is bound in formattingKeymap', () => {
    for (const h of HEADING_LEVELS) expect(bound.has(h.key)).toBe(true);
    expect(HEADING_LEVELS.map((h) => h.level)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe('readout helpers', () => {
  test('link label follows whether the caret is in a link', () => {
    expect(linkLabel(NO_FORMAT)).toBe('Insert link');
    expect(linkLabel({ ...NO_FORMAT, link: true })).toBe('Edit link');
  });
  test('heading value is the level, or empty for a mixed selection', () => {
    expect(headingValue({ ...NO_FORMAT, heading: 3 })).toBe('3');
    expect(headingValue(NO_FORMAT)).toBe('0');
    expect(headingValue({ ...NO_FORMAT, heading: null })).toBe('');
  });
});

describe('rovingIndex', () => {
  test('arrows move one control and clamp at the ends', () => {
    expect(rovingIndex(2, 'ArrowRight', 6)).toBe(3);
    expect(rovingIndex(5, 'ArrowRight', 6)).toBe(5);
    expect(rovingIndex(2, 'ArrowLeft', 6)).toBe(1);
    expect(rovingIndex(0, 'ArrowLeft', 6)).toBe(0);
  });
  test('Home / End jump to the first / last control', () => {
    expect(rovingIndex(3, 'Home', 6)).toBe(0);
    expect(rovingIndex(3, 'End', 6)).toBe(5);
  });
  test('other keys are not the Toolbar\'s', () => {
    expect(rovingIndex(3, 'Tab', 6)).toBeNull();
    expect(rovingIndex(3, 'Escape', 6)).toBeNull();
    expect(rovingIndex(0, 'ArrowRight', 0)).toBeNull();
  });
});

describe('isToolbarFocusKey', () => {
  const k = (key: string, mods: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {}) => ({
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...mods,
  });
  test('Alt+F10 and nothing else', () => {
    expect(isToolbarFocusKey(k('F10', { altKey: true }))).toBe(true);
    expect(isToolbarFocusKey(k('F10'))).toBe(false);
    expect(isToolbarFocusKey(k('F10', { altKey: true, shiftKey: true }))).toBe(false);
  });
});
