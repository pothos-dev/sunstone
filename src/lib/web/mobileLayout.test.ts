import { describe, expect, test } from 'bun:test';
import { escapeTarget, toggleDrawer } from './mobileLayout';

describe('toggleDrawer', () => {
  test('opens a closed side', () => {
    expect(toggleDrawer(null, 'left')).toBe('left');
    expect(toggleDrawer(null, 'right')).toBe('right');
  });

  test('closes the side that is already open', () => {
    expect(toggleDrawer('left', 'left')).toBeNull();
    expect(toggleDrawer('right', 'right')).toBeNull();
  });

  test('switches sides instead of stacking two drawers', () => {
    expect(toggleDrawer('left', 'right')).toBe('right');
    expect(toggleDrawer('right', 'left')).toBe('left');
  });
});

describe('escapeTarget', () => {
  test('nothing open → nothing to close', () => {
    expect(escapeTarget({ dialogOpen: false, menuOpen: false, drawer: null })).toBeNull();
  });

  test('an open dialog owns Escape', () => {
    expect(escapeTarget({ dialogOpen: true, menuOpen: true, drawer: 'left' })).toBeNull();
  });

  test('the menu closes before a drawer', () => {
    expect(escapeTarget({ dialogOpen: false, menuOpen: true, drawer: 'left' })).toBe('menu');
    expect(escapeTarget({ dialogOpen: false, menuOpen: false, drawer: 'right' })).toBe('drawer');
  });
});
