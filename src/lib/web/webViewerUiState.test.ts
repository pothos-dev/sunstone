import { describe, expect, test } from 'bun:test';
import { snapshotWebViewerUiState, restoreWebViewerUiState } from './webViewerUiState';
import type { WebUiState } from './uiState';

describe('snapshotWebViewerUiState', () => {
  test('captures all fields, turning the expanded-folders Set into an array', () => {
    const snap = snapshotWebViewerUiState({
      themeMode: 'dark',
      expandedFolders: new Set(['a', 'a/b']),
      explorerOpen: false,
      tagsOpen: true,
      outlineOpen: false,
      backlinksOpen: true,
      leftSidebarOpen: false,
      rightSidebarOpen: true,
      leftSidebarWidth: 300,
      rightSidebarWidth: 260,
      propertiesOpen: false,
    });
    expect(snap).toEqual({
      themeMode: 'dark',
      expandedFolders: ['a', 'a/b'],
      explorerOpen: false,
      tagsOpen: true,
      outlineOpen: false,
      backlinksOpen: true,
      leftSidebarOpen: false,
      rightSidebarOpen: true,
      leftSidebarWidth: 300,
      rightSidebarWidth: 260,
      propertiesOpen: false,
    });
  });
});

describe('restoreWebViewerUiState', () => {
  test('returns an empty patch for an empty partial', () => {
    expect(restoreWebViewerUiState({})).toEqual({});
  });

  test('only includes keys actually present in the loaded state', () => {
    const patch = restoreWebViewerUiState({ explorerOpen: false });
    expect(patch).toEqual({ explorerOpen: false });
  });

  test('rebuilds expandedFolders as a Set', () => {
    const patch = restoreWebViewerUiState({ expandedFolders: ['x', 'y'] });
    expect(patch.expandedFolders).toEqual(new Set(['x', 'y']));
  });

  test('clamps sidebar widths', () => {
    const patch = restoreWebViewerUiState({ leftSidebarWidth: 1, rightSidebarWidth: 99999 });
    expect(patch.leftSidebarWidth).toBeGreaterThan(1);
    expect(patch.rightSidebarWidth).toBeLessThan(99999);
  });

  test('ignores wrong-typed boolean/array fields (themeMode is truthy-checked only, matching the original inline logic)', () => {
    const ui = { explorerOpen: 'yes', expandedFolders: 'not-an-array' } as unknown as Partial<WebUiState>;
    expect(restoreWebViewerUiState(ui)).toEqual({});
  });

  test('restores full state', () => {
    const full: WebUiState = {
      themeMode: 'light',
      expandedFolders: ['x'],
      explorerOpen: true,
      tagsOpen: false,
      outlineOpen: true,
      backlinksOpen: false,
      leftSidebarOpen: true,
      rightSidebarOpen: false,
      leftSidebarWidth: 250,
      rightSidebarWidth: 250,
      propertiesOpen: true,
    };
    const patch = restoreWebViewerUiState(full);
    expect(patch.themeMode).toBe('light');
    expect(patch.expandedFolders).toEqual(new Set(['x']));
    expect(patch.explorerOpen).toBe(true);
    expect(patch.tagsOpen).toBe(false);
    expect(patch.outlineOpen).toBe(true);
    expect(patch.backlinksOpen).toBe(false);
    expect(patch.leftSidebarOpen).toBe(true);
    expect(patch.rightSidebarOpen).toBe(false);
    expect(patch.propertiesOpen).toBe(true);
  });
});
