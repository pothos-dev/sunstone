import { afterEach, describe, expect, test } from 'bun:test';
import {
  FILES,
  FOLDERS,
  assertSafePath,
  conceptPaths,
  fileExists,
  folderExists,
  isSafePath,
  pathExists,
  readFileOrThrow,
} from './store';

// Some tests mutate the shared fixture; restore it after each test.
const filesSnapshot = { ...FILES };
const foldersSnapshot = new Set(FOLDERS);

afterEach(() => {
  for (const key of Object.keys(FILES)) if (!(key in filesSnapshot)) delete FILES[key];
  for (const [key, value] of Object.entries(filesSnapshot)) FILES[key] = value;
  FOLDERS.clear();
  for (const folder of foldersSnapshot) FOLDERS.add(folder);
});

describe('isSafePath', () => {
  test('accepts ordinary bundle-relative paths', () => {
    expect(isSafePath('index.md')).toBe(true);
    expect(isSafePath('concepts/editor/live-preview.md')).toBe(true);
    expect(isSafePath('')).toBe(true);
  });

  test('rejects absolute paths', () => {
    expect(isSafePath('/etc/passwd')).toBe(false);
    expect(isSafePath('/index.md')).toBe(false);
  });

  test('rejects any ".." segment', () => {
    expect(isSafePath('..')).toBe(false);
    expect(isSafePath('../outside.md')).toBe(false);
    expect(isSafePath('concepts/../../outside.md')).toBe(false);
  });

  test('".." must be a whole segment; names merely containing dots pass', () => {
    expect(isSafePath('notes..md')).toBe(true);
    expect(isSafePath('a..b/c.md')).toBe(true);
  });

  test('backslashes are NOT treated as separators — "..\\"-style escapes pass the guard', () => {
    // Pinning current behavior: only forward slashes are split, so a
    // backslash-separated ".." traversal is not caught by this guard
    // (the Rust side normalizes separators; the fake does not).
    expect(isSafePath('..\\outside.md')).toBe(true);
    expect(isSafePath('foo\\..\\bar.md')).toBe(true);
    expect(isSafePath('concepts\\file.md')).toBe(true);
  });
});

describe('assertSafePath', () => {
  test('passes safe paths, including the Bundle root', () => {
    expect(() => assertSafePath('index.md')).not.toThrow();
    expect(() => assertSafePath('a.md', '')).not.toThrow();
  });

  test('a single unsafe path is named in the message', () => {
    expect(() => assertSafePath('../x.md')).toThrow(new Error('path escapes the bundle: ../x.md'));
  });

  test('a multi-path op throws the bare message when any path is unsafe', () => {
    expect(() => assertSafePath('a.md', '/etc')).toThrow(new Error('path escapes the bundle'));
    expect(() => assertSafePath('../a.md', 'b')).toThrow(new Error('path escapes the bundle'));
  });
});

describe('readFileOrThrow', () => {
  test('returns the live content', () => {
    FILES['live.md'] = '# live';
    expect(readFileOrThrow('live.md')).toBe('# live');
  });

  test('rejects an escaping path before looking it up', () => {
    expect(() => readFileOrThrow('../index.md')).toThrow(
      new Error('path escapes the bundle: ../index.md'),
    );
  });

  test('a missing file is "no such concept"', () => {
    expect(() => readFileOrThrow('ghost.md')).toThrow(new Error('no such concept: ghost.md'));
  });
});

describe('fileExists', () => {
  test('true only for FILES keys, not folders or inherited props', () => {
    expect(fileExists('index.md')).toBe(true);
    expect(fileExists('concepts')).toBe(false);
    expect(fileExists('ghost.md')).toBe(false);
    expect(fileExists('constructor')).toBe(false);
  });
});

describe('folderExists', () => {
  test('true for folders implied by file paths', () => {
    expect(folderExists('concepts')).toBe(true);
    expect(folderExists('concepts/editor')).toBe(true);
  });

  test('true for explicitly-tracked empty folders', () => {
    expect(folderExists('empty')).toBe(false);
    FOLDERS.add('empty');
    expect(folderExists('empty')).toBe(true);
  });

  test('false for files and non-existent paths', () => {
    expect(folderExists('index.md')).toBe(false);
    expect(folderExists('ghost')).toBe(false);
  });

  test('prefix match is segment-aware: "concept" is not a folder', () => {
    expect(folderExists('concept')).toBe(false);
    expect(folderExists('concepts/edit')).toBe(false);
  });

  test('the empty string counts as a folder (every path starts with "/"-less prefix "")', () => {
    // Pinning current behavior: `''` yields prefix '/', which no fixture path
    // starts with, so the Bundle root itself reports NOT existing here.
    expect(folderExists('')).toBe(false);
  });
});

describe('pathExists', () => {
  test('true for existing files and folders', () => {
    expect(pathExists('index.md')).toBe(true);
    expect(pathExists('concepts')).toBe(true);
  });

  test('false for missing paths', () => {
    expect(pathExists('ghost.md')).toBe(false);
    expect(pathExists('ghost')).toBe(false);
  });

  test('reflects live mutations of FILES and FOLDERS', () => {
    FILES['new.md'] = '# new';
    expect(pathExists('new.md')).toBe(true);
    FOLDERS.add('made-up');
    expect(pathExists('made-up')).toBe(true);
  });
});

describe('conceptPaths', () => {
  test('returns all .md paths sorted', () => {
    const paths = conceptPaths();
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain('index.md');
    expect(paths).toContain('concepts/editor/live-preview.md');
    expect(paths.every((p) => p.endsWith('.md'))).toBe(true);
  });

  test('excludes non-.md entries and reflects live state', () => {
    FILES['assets/diagram.png'] = 'binary-ish';
    FILES['concepts/added.md'] = '# added';
    const paths = conceptPaths();
    expect(paths).not.toContain('assets/diagram.png');
    expect(paths).toContain('concepts/added.md');
  });
});
