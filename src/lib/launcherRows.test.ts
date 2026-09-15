// Unit tests for the launcher's pure row building. Run with `bun test src/lib`.
// Pins the empty-query passthrough (recency order preserved), fuzzy filtering
// over the whole PATH, and the deterministic tie-break.
import { describe, expect, test } from 'bun:test';
import { launcherRows } from './launcherRows';
import type { KnownBundle } from './types';

const bundle = (path: string, over: Partial<KnownBundle> = {}): KnownBundle => ({
  path,
  name: path.split('/').filter(Boolean).pop() ?? path,
  lastOpened: 1000,
  exists: true,
  ...over,
});

const paths = (rows: ReturnType<typeof launcherRows>) => rows.map((r) => r.bundle.path);

describe('launcherRows', () => {
  const known = [
    bundle('/home/user/Knowledge Base'),
    bundle('/home/user/Project Notes'),
    bundle('/home/user/Archive'),
  ];

  test('an empty query keeps the given order and highlights nothing', () => {
    const rows = launcherRows('', known);
    expect(paths(rows)).toEqual([
      '/home/user/Knowledge Base',
      '/home/user/Project Notes',
      '/home/user/Archive',
    ]);
    expect(rows.every((r) => r.positions.length === 0)).toBe(true);
  });

  test('a whitespace-only query counts as empty', () => {
    expect(paths(launcherRows('   ', known))).toHaveLength(3);
  });

  test('filters to fuzzy matches and drops the rest', () => {
    expect(paths(launcherRows('proj', known))).toEqual(['/home/user/Project Notes']);
    expect(paths(launcherRows('zzz', known))).toEqual([]);
  });

  test('matches the directory part of the path, not just the folder name', () => {
    expect(paths(launcherRows('user/arch', known))).toEqual(['/home/user/Archive']);
  });

  test('is case-insensitive', () => {
    expect(paths(launcherRows('KNOW', known))).toEqual(['/home/user/Knowledge Base']);
  });

  test('ranks the tighter match first', () => {
    const rows = launcherRows('notes', [
      bundle('/home/user/Project Notes'),
      bundle('/home/user/n/o/t/e/s'),
    ]);
    expect(paths(rows)[0]).toBe('/home/user/Project Notes');
  });

  test('breaks score ties by shorter path, then alphabetically', () => {
    const rows = launcherRows('notes', [
      bundle('/b/notes'),
      bundle('/a/notes'),
      bundle('/aa/notes'),
    ]);
    expect(paths(rows)).toEqual(['/a/notes', '/b/notes', '/aa/notes']);
  });

  test('reports positions inside the path for highlighting', () => {
    const [row] = launcherRows('arch', known);
    expect(row.bundle.path.slice(row.positions[0], row.positions[3] + 1)).toBe('Arch');
  });
});
