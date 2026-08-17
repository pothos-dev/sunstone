import { afterEach, describe, expect, test } from 'bun:test';
import { COMMIT_HEAD_DISTANCE, FAKE_COMMITS, committedContentAt, revToVersion } from './git';
import { COMMITTED_FILES, FILES } from './store';

// One test edits the shared working tree; restore it afterwards.
const filesSnapshot = { ...FILES };

afterEach(() => {
  for (const key of Object.keys(FILES)) if (!(key in filesSnapshot)) delete FILES[key];
  for (const [key, value] of Object.entries(filesSnapshot)) FILES[key] = value;
});

describe('revToVersion', () => {
  test('each FAKE_COMMITS short hash resolves to its own index (newest = 0)', () => {
    for (let i = 0; i < FAKE_COMMITS.length; i++) {
      expect(revToVersion(FAKE_COMMITS[i].hash)).toBe(i);
    }
  });

  test('HEAD resolves to the newest file version', () => {
    expect(revToVersion('HEAD')).toBe(0);
    expect(revToVersion('HEAD~0')).toBe(0);
  });

  test('the deliberate HEAD~N distance gaps: HEAD~1 is NOT the second file version', () => {
    // COMMIT_HEAD_DISTANCE is [0, 2, 3]: an unrelated commit sits at HEAD~1,
    // where the file is unchanged — it stays at its newest version (0).
    expect(COMMIT_HEAD_DISTANCE).toEqual([0, 2, 3]);
    expect(revToVersion('HEAD~1')).toBe(0);
    expect(revToVersion('HEAD~2')).toBe(1);
    expect(revToVersion('HEAD~3')).toBe(2);
  });

  test('a rev older than the file\'s first commit resolves to null', () => {
    expect(revToVersion('HEAD~4')).toBeNull();
    expect(revToVersion('HEAD~100')).toBeNull();
  });

  test('unknown revs resolve to null', () => {
    expect(revToVersion('deadbee')).toBeNull();
    expect(revToVersion('main')).toBeNull();
    expect(revToVersion('HEAD^')).toBeNull();
    expect(revToVersion('')).toBeNull();
  });

  test('surrounding whitespace is trimmed', () => {
    expect(revToVersion('  HEAD~2 ')).toBe(1);
    expect(revToVersion(` ${FAKE_COMMITS[0].hash} `)).toBe(0);
  });
});

describe('committedContentAt', () => {
  test('null for a path never committed', () => {
    expect(committedContentAt('nope.md', 'HEAD')).toBeNull();
  });

  test('null for an unrecognized rev even on a committed path', () => {
    expect(committedContentAt('index.md', 'bogus')).toBeNull();
    expect(committedContentAt('index.md', 'HEAD~99')).toBeNull();
  });

  test('HEAD returns the committed snapshot, not the edited working tree', () => {
    const committed = COMMITTED_FILES['index.md'];
    FILES['index.md'] = '# edited in the working tree\n';
    expect(committedContentAt('index.md', 'HEAD')).toBe(committed);
  });

  test('a path created at runtime (working tree only) is untracked here', () => {
    FILES['fresh.md'] = '# fresh';
    expect(committedContentAt('fresh.md', 'HEAD')).toBeNull();
  });

  test('older versions prepend one unique marker line per generation', () => {
    const base = COMMITTED_FILES['index.md'];
    // Version 1 (hash 0f1e2d3, also HEAD~2): one marker.
    const v1 = `> revision marker 1 — older wording (generation 1)\n\n${base}`;
    expect(committedContentAt('index.md', 'HEAD~2')).toBe(v1);
    expect(committedContentAt('index.md', FAKE_COMMITS[1].hash)).toBe(v1);
    // Version 2 (hash 9a8b7c6, also HEAD~3): two markers, newest generation first.
    const v2 =
      '> revision marker 2 — older wording (generation 2)\n' +
      `> revision marker 1 — older wording (generation 1)\n\n${base}`;
    expect(committedContentAt('index.md', 'HEAD~3')).toBe(v2);
    expect(committedContentAt('index.md', FAKE_COMMITS[2].hash)).toBe(v2);
  });

  test('HEAD~1 (an unrelated ancestor) yields the same content as HEAD — an empty diff', () => {
    expect(committedContentAt('index.md', 'HEAD~1')).toBe(
      committedContentAt('index.md', 'HEAD')!,
    );
  });
});
