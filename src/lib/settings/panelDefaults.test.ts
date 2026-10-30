import { describe, expect, test } from 'bun:test';
import { BUILTIN_PANEL_DEFAULTS, resolvePanelDefaults } from './panelDefaults';
import { sessionFromBundleState } from '$lib/state/sessionState';
import type { BundleState } from '$lib/types';

const fresh: BundleState = { lastOpenConcept: null, expandedFolders: [] };

describe('resolvePanelDefaults', () => {
  test('missing or malformed config gives the built-ins', () => {
    expect(resolvePanelDefaults(undefined)).toEqual(BUILTIN_PANEL_DEFAULTS);
    expect(resolvePanelDefaults([true])).toEqual(BUILTIN_PANEL_DEFAULTS);
  });

  test('takes booleans and a known editor mode, ignores the rest', () => {
    const d = resolvePanelDefaults({ tags: true, explorer: 'no', editorMode: 'editing', backlinks: false });
    expect(d.tags).toBe(true);
    expect(d.explorer).toBe(true);
    expect(d.backlinks).toBe(false);
    expect(d.editorMode).toBe('editing');
    expect(resolvePanelDefaults({ editorMode: 'hybrid' }).editorMode).toBe('read');
  });
});

describe('sessionFromBundleState with defaults', () => {
  const defaults = resolvePanelDefaults({ tags: true, outline: false, titles: false, editorMode: 'editing' });

  test('a Bundle opened for the first time takes the defaults', () => {
    const s = sessionFromBundleState(fresh, defaults);
    expect(s.tagsOpen).toBe(true);
    expect(s.outlineOpen).toBe(false);
    expect(s.titlesShown).toBe(false);
    expect(s.editorMode).toBe('editing');
  });

  test('what the Bundle remembers wins', () => {
    // A legacy mode name still migrates rather than falling back to the default.
    const s = sessionFromBundleState({ ...fresh, tagsOpen: false, editorMode: 'view' as BundleState['editorMode'] }, defaults);
    expect(s.tagsOpen).toBe(false);
    expect(s.editorMode).toBe('read');
  });

  test('without defaults it behaves as before', () => {
    const s = sessionFromBundleState(fresh);
    expect(s.tagsOpen).toBe(false);
    expect(s.outlineOpen).toBe(true);
    expect(s.editorMode).toBe('read');
  });
});
