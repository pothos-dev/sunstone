import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { loadUiState, saveThemeMode } from './uiState';

const KEY = 'sunstone:webUI';

describe('saveThemeMode', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  test('stores the mode when nothing is stored yet', () => {
    saveThemeMode('dark');
    expect(loadUiState()).toEqual({ themeMode: 'dark' });
  });

  test('keeps the other stored fields', () => {
    store.set(KEY, JSON.stringify({ themeMode: 'light', explorerOpen: false }));
    saveThemeMode('dark');
    expect(loadUiState()).toEqual({ themeMode: 'dark', explorerOpen: false });
  });

  test('replaces corrupt stored state', () => {
    store.set(KEY, '{not json');
    saveThemeMode('light');
    expect(loadUiState()).toEqual({ themeMode: 'light' });
  });
});
