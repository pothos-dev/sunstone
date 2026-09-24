import { describe, expect, test } from 'bun:test';
import { bundleStateFromSession, sessionFromBundleState } from './sessionState';
import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from '$lib/sidebarResize';
import type { StoredLayout } from './layoutPersist';

describe('sessionFromBundleState', () => {
  test('a fresh Bundle gets every per-field default', () => {
    const s = sessionFromBundleState({ lastOpenConcept: null, expandedFolders: [] });
    expect(s).toEqual({
      lastOpenConcept: null,
      expandedFolders: new Set(),
      recentFiles: [],
      leftSidebarOpen: true,
      explorerOpen: true,
      tagsOpen: false,
      backlinksOpen: true,
      outlineOpen: true,
      rightSidebarOpen: false,
      leftSidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      rightSidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      frontmatterShown: false,
      editorMode: 'read',
      layout: null,
      window: undefined,
    });
  });

  test('stored values win over the defaults', () => {
    const s = sessionFromBundleState({
      lastOpenConcept: 'a.md',
      expandedFolders: ['x', 'x/y'],
      recentFiles: ['a.md', 'b.md'],
      leftSidebarOpen: false,
      explorerOpen: false,
      tagsOpen: true,
      backlinksOpen: false,
      outlineOpen: false,
      rightSidebarOpen: true,
      frontmatterShown: true,
      editorMode: 'editing',
    });
    expect(s.lastOpenConcept).toBe('a.md');
    expect([...s.expandedFolders]).toEqual(['x', 'x/y']);
    expect(s.recentFiles).toEqual(['a.md', 'b.md']);
    expect(s.leftSidebarOpen).toBe(false);
    expect(s.explorerOpen).toBe(false);
    expect(s.tagsOpen).toBe(true);
    expect(s.backlinksOpen).toBe(false);
    expect(s.outlineOpen).toBe(false);
    expect(s.rightSidebarOpen).toBe(true);
    expect(s.frontmatterShown).toBe(true);
    expect(s.editorMode).toBe('editing');
  });

  test('legacy propertiesShown seeds frontmatterShown only when it is absent', () => {
    const base = { lastOpenConcept: null, expandedFolders: [] };
    expect(sessionFromBundleState({ ...base, propertiesShown: true }).frontmatterShown).toBe(true);
    expect(
      sessionFromBundleState({ ...base, propertiesShown: true, frontmatterShown: false })
        .frontmatterShown,
    ).toBe(false);
  });

  test('legacy tri-state editor modes migrate', () => {
    const base = { lastOpenConcept: null, expandedFolders: [] };
    const mode = (m: string) =>
      sessionFromBundleState({ ...base, editorMode: m as never }).editorMode;
    expect(mode('edit')).toBe('editing');
    expect(mode('hybrid')).toBe('editing');
    expect(mode('view')).toBe('read');
    expect(mode('garbage')).toBe('read');
  });

  test('sidebar widths are clamped on read', () => {
    const s = sessionFromBundleState({
      lastOpenConcept: null,
      expandedFolders: [],
      leftSidebarWidth: 1,
      rightSidebarWidth: 1e9,
    });
    expect(s.leftSidebarWidth).toBe(MIN_SIDEBAR_WIDTH);
    expect(s.rightSidebarWidth).toBe(MAX_SIDEBAR_WIDTH);
  });

  test('window is passed through by reference', () => {
    const geometry = { x: 1, y: 2 };
    const s = sessionFromBundleState({ lastOpenConcept: null, expandedFolders: [], window: geometry });
    expect(s.window).toBe(geometry);
  });
});

describe('bundleStateFromSession', () => {
  const layout: StoredLayout = {
    columns: [{ weight: 1, tiles: [{ path: 'a.md', mode: 'read', weight: 1 }] }],
    active: [0, 0],
  };

  test('round-trips a loaded state (minus the legacy propertiesShown)', () => {
    const geometry = { w: 800 };
    const stored = {
      lastOpenConcept: 'a.md',
      expandedFolders: ['x'],
      recentFiles: ['a.md'],
      leftSidebarOpen: false,
      explorerOpen: true,
      tagsOpen: true,
      backlinksOpen: false,
      rightSidebarOpen: true,
      leftSidebarWidth: 300,
      rightSidebarWidth: 320,
      outlineOpen: false,
      frontmatterShown: true,
      editorMode: 'editing' as const,
      layout,
      window: geometry,
    };
    const out = bundleStateFromSession(
      sessionFromBundleState({ ...stored, propertiesShown: false }),
    );
    expect(out).toEqual(stored);
    expect(Object.keys(out)).toEqual(Object.keys(stored));
    expect(out.window).toBe(geometry);
    expect('propertiesShown' in out).toBe(false);
  });

  test('copies the collections and always carries the window key', () => {
    const fields = sessionFromBundleState({ lastOpenConcept: null, expandedFolders: ['x'] });
    const out = bundleStateFromSession(fields);
    expect(out.expandedFolders).toEqual(['x']);
    expect(out.recentFiles).not.toBe(fields.recentFiles);
    expect('window' in out).toBe(true);
    expect(out.window).toBeUndefined();
  });
});
