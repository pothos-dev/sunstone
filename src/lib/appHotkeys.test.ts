import { describe, expect, test } from 'bun:test';
import { routeAppHotkey, type AppHotkeyContext, type AppHotkeyIntent } from './appHotkeys';

function keydown(over: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    key: '',
    ...over,
  } as KeyboardEvent;
}

function ctx(over: Partial<AppHotkeyContext> = {}): AppHotkeyContext {
  return {
    conceptOpen: true,
    inCmEditor: false,
    reviewActive: false,
    focusedRegion: null,
    propertiesEditing: false,
    quickNavOpen: false,
    quickNavTagActive: false,
    ...over,
  };
}

describe('routeAppHotkey', () => {
  test('Ctrl+K / Cmd+K toggles quick-nav', () => {
    expect(routeAppHotkey(keydown({ ctrlKey: true, key: 'k' }), ctx())).toEqual({
      kind: 'toggle-quicknav',
    });
    expect(routeAppHotkey(keydown({ metaKey: true, key: 'K' }), ctx())).toEqual({
      kind: 'toggle-quicknav',
    });
    // Extra modifiers disqualify it.
    expect(routeAppHotkey(keydown({ ctrlKey: true, shiftKey: true, key: 'k' }), ctx())).toBeNull();
    expect(routeAppHotkey(keydown({ ctrlKey: true, altKey: true, key: 'k' }), ctx())).toBeNull();
  });

  test('Ctrl+Shift+F / Cmd+Shift+F toggles search', () => {
    expect(routeAppHotkey(keydown({ ctrlKey: true, shiftKey: true, key: 'f' }), ctx())).toEqual({
      kind: 'toggle-search',
    });
    expect(routeAppHotkey(keydown({ metaKey: true, shiftKey: true, key: 'F' }), ctx())).toEqual({
      kind: 'toggle-search',
    });
    // Search toggles regardless of whether a Concept is open.
    expect(
      routeAppHotkey(keydown({ ctrlKey: true, shiftKey: true, key: 'f' }), ctx({ conceptOpen: false })),
    ).toEqual({ kind: 'toggle-search' });
  });

  test('Ctrl+P / Cmd+P prints only when a Concept is open', () => {
    expect(routeAppHotkey(keydown({ ctrlKey: true, key: 'p' }), ctx())).toEqual({ kind: 'print' });
    expect(routeAppHotkey(keydown({ metaKey: true, key: 'p' }), ctx())).toEqual({ kind: 'print' });
    // No Concept open → null (browser print dialog untouched).
    expect(routeAppHotkey(keydown({ ctrlKey: true, key: 'p' }), ctx({ conceptOpen: false }))).toBeNull();
  });

  test('Ctrl+F / Cmd+F enters find only when a Concept is open', () => {
    expect(routeAppHotkey(keydown({ ctrlKey: true, key: 'f' }), ctx())).toEqual({ kind: 'find' });
    expect(routeAppHotkey(keydown({ metaKey: true, key: 'f' }), ctx())).toEqual({ kind: 'find' });
    expect(routeAppHotkey(keydown({ ctrlKey: true, key: 'f' }), ctx({ conceptOpen: false }))).toBeNull();
  });

  test('Ctrl+Z / Cmd+Z routes undo unless focus is inside CodeMirror', () => {
    expect(routeAppHotkey(keydown({ ctrlKey: true, key: 'z' }), ctx())).toEqual({ kind: 'undo' });
    expect(routeAppHotkey(keydown({ metaKey: true, key: 'Z' }), ctx())).toEqual({ kind: 'undo' });
    expect(routeAppHotkey(keydown({ ctrlKey: true, key: 'z' }), ctx({ inCmEditor: true }))).toBeNull();
  });

  test('Ctrl+Shift+Z, Ctrl+Y and Cmd variants route redo unless in CodeMirror', () => {
    expect(routeAppHotkey(keydown({ ctrlKey: true, shiftKey: true, key: 'z' }), ctx())).toEqual({
      kind: 'redo',
    });
    expect(routeAppHotkey(keydown({ ctrlKey: true, key: 'y' }), ctx())).toEqual({ kind: 'redo' });
    expect(routeAppHotkey(keydown({ metaKey: true, shiftKey: true, key: 'Z' }), ctx())).toEqual({
      kind: 'redo',
    });
    expect(routeAppHotkey(keydown({ metaKey: true, key: 'y' }), ctx())).toEqual({ kind: 'redo' });
    expect(
      routeAppHotkey(keydown({ ctrlKey: true, key: 'y' }), ctx({ inCmEditor: true })),
    ).toBeNull();
    // Alt disqualifies undo/redo entirely.
    expect(routeAppHotkey(keydown({ ctrlKey: true, altKey: true, key: 'z' }), ctx())).toBeNull();
  });

  test('Ctrl+Alt+Left/Right route history back/forward (Ctrl only, not Cmd)', () => {
    expect(routeAppHotkey(keydown({ ctrlKey: true, altKey: true, key: 'ArrowLeft' }), ctx())).toEqual(
      { kind: 'history-back' },
    );
    expect(
      routeAppHotkey(keydown({ ctrlKey: true, altKey: true, key: 'ArrowRight' }), ctx()),
    ).toEqual({ kind: 'history-forward' });
    // Meta or Shift added → not history.
    expect(
      routeAppHotkey(keydown({ ctrlKey: true, altKey: true, metaKey: true, key: 'ArrowLeft' }), ctx()),
    ).toBeNull();
    expect(
      routeAppHotkey(
        keydown({ ctrlKey: true, altKey: true, shiftKey: true, key: 'ArrowLeft' }),
        ctx(),
      ),
    ).toBeNull();
    // Cmd+Alt+Left alone is not the history hotkey.
    expect(
      routeAppHotkey(keydown({ metaKey: true, altKey: true, key: 'ArrowLeft' }), ctx()),
    ).toBeNull();
  });

  test('plain Escape exits review first when review is active', () => {
    expect(routeAppHotkey(keydown({ key: 'Escape' }), ctx({ reviewActive: true }))).toEqual({
      kind: 'exit-review',
    });
    // Any modifier disqualifies the review Escape.
    expect(
      routeAppHotkey(keydown({ key: 'Escape', shiftKey: true }), ctx({ reviewActive: true })),
    ).toBeNull();
  });

  test('plain Escape routes the unified peel with the local-peel flag', () => {
    expect(routeAppHotkey(keydown({ key: 'Escape' }), ctx())).toEqual({
      kind: 'escape',
      localPeelActive: false,
    });
    // Editor Region focused → local peel.
    expect(routeAppHotkey(keydown({ key: 'Escape' }), ctx({ focusedRegion: 'editor' }))).toEqual({
      kind: 'escape',
      localPeelActive: true,
    });
    // Properties Region + non-nav mode → local peel; nav mode → not.
    expect(
      routeAppHotkey(
        keydown({ key: 'Escape' }),
        ctx({ focusedRegion: 'properties', propertiesEditing: true }),
      ),
    ).toEqual({ kind: 'escape', localPeelActive: true });
    expect(
      routeAppHotkey(keydown({ key: 'Escape' }), ctx({ focusedRegion: 'properties' })),
    ).toEqual({ kind: 'escape', localPeelActive: false });
    // Quick-nav tag drill-down open → local peel (needs BOTH flags).
    expect(
      routeAppHotkey(
        keydown({ key: 'Escape' }),
        ctx({ quickNavOpen: true, quickNavTagActive: true }),
      ),
    ).toEqual({ kind: 'escape', localPeelActive: true });
    expect(
      routeAppHotkey(keydown({ key: 'Escape' }), ctx({ quickNavTagActive: true })),
    ).toEqual({ kind: 'escape', localPeelActive: false });
  });

  test('Alt+arrows (alone) route Region/tile movement', () => {
    expect(routeAppHotkey(keydown({ altKey: true, key: 'ArrowLeft' }), ctx())).toEqual({
      kind: 'move',
      dir: 'left',
    });
    expect(routeAppHotkey(keydown({ altKey: true, key: 'ArrowRight' }), ctx())).toEqual({
      kind: 'move',
      dir: 'right',
    });
    expect(routeAppHotkey(keydown({ altKey: true, key: 'ArrowUp' }), ctx())).toEqual({
      kind: 'move',
      dir: 'up',
    });
    expect(routeAppHotkey(keydown({ altKey: true, key: 'ArrowDown' }), ctx())).toEqual({
      kind: 'move',
      dir: 'down',
    });
    // Ctrl alongside Alt is the history chord, not a move (see the test above);
    // Shift alongside Alt disqualifies the move entirely.
    expect(
      routeAppHotkey(keydown({ altKey: true, ctrlKey: true, key: 'ArrowLeft' }), ctx()),
    ).toEqual({ kind: 'history-back' });
    expect(
      routeAppHotkey(keydown({ altKey: true, shiftKey: true, key: 'ArrowLeft' }), ctx()),
    ).toBeNull();
    // A non-movement key with Alt is ignored.
    expect(routeAppHotkey(keydown({ altKey: true, key: 'x' }), ctx())).toBeNull();
  });

  test('Ctrl/Cmd with +/-/0 routes UI zoom, on both the main row and the numpad', () => {
    const zoom = (step: 'in' | 'out' | 'reset'): AppHotkeyIntent => ({ kind: 'zoom', step });
    expect(routeAppHotkey(keydown({ ctrlKey: true, key: '=' }), ctx())).toEqual(zoom('in'));
    // `+` arrives with Shift held on most layouts — still a zoom-in.
    expect(routeAppHotkey(keydown({ ctrlKey: true, shiftKey: true, key: '+' }), ctx())).toEqual(
      zoom('in'),
    );
    expect(routeAppHotkey(keydown({ metaKey: true, key: '-' }), ctx())).toEqual(zoom('out'));
    expect(routeAppHotkey(keydown({ ctrlKey: true, key: '0' }), ctx())).toEqual(zoom('reset'));
    expect(
      routeAppHotkey(keydown({ ctrlKey: true, key: 'Unidentified', code: 'NumpadAdd' }), ctx()),
    ).toEqual(zoom('in'));
    // Without the primary modifier (or with Alt) it is not a zoom chord.
    expect(routeAppHotkey(keydown({ key: '-' }), ctx())).toBeNull();
    expect(routeAppHotkey(keydown({ ctrlKey: true, altKey: true, key: '-' }), ctx())).toBeNull();
  });

  test('unmodified ordinary keys route nothing', () => {
    expect(routeAppHotkey(keydown({ key: 'a' }), ctx())).toBeNull();
    expect(routeAppHotkey(keydown({ key: 'ArrowLeft' }), ctx())).toBeNull();
  });
});
