import { describe, expect, test } from 'bun:test';
import {
  type RegionId,
  REGION_CELL,
  ALL_REGIONS,
  regionAt,
  move,
  pickColumnLanding,
  directionForKey,
} from './regionGrid';

describe('directionForKey', () => {
  test('maps arrows and hjkl to directions', () => {
    expect(directionForKey('ArrowLeft')).toBe('left');
    expect(directionForKey('h')).toBe('left');
    expect(directionForKey('ArrowDown')).toBe('down');
    expect(directionForKey('j')).toBe('down');
    expect(directionForKey('ArrowUp')).toBe('up');
    expect(directionForKey('k')).toBe('up');
    expect(directionForKey('ArrowRight')).toBe('right');
    expect(directionForKey('l')).toBe('right');
  });
  test('returns null for non-movement keys', () => {
    expect(directionForKey('x')).toBeNull();
    expect(directionForKey('Enter')).toBeNull();
    expect(directionForKey('H')).toBeNull(); // case-sensitive: only lowercase hjkl
  });
});

/** All Regions visible. */
const allVisible = () => true;
/** Visibility predicate from an explicit allow-set. */
const visibleSet = (...ids: RegionId[]) => {
  const set = new Set(ids);
  return (id: RegionId) => set.has(id);
};
/** Empty per-column landing memory (no stickiness). */
const noMemory: ReadonlyArray<RegionId | null> = [null, null, null];

describe('grid geometry', () => {
  test('every Region has a distinct cell', () => {
    const cells = new Set(ALL_REGIONS.map((id) => REGION_CELL[id].join(',')));
    expect(cells.size).toBe(ALL_REGIONS.length);
  });

  test('regionAt is the inverse of REGION_CELL', () => {
    for (const id of ALL_REGIONS) {
      const [c, r] = REGION_CELL[id];
      expect(regionAt(c, r)).toBe(id);
    }
  });
});

describe('move: up/down within a column', () => {
  test('down moves to the lower row, up to the upper row', () => {
    expect(move('explorer', 'down', allVisible, noMemory)).toBe('tags');
    expect(move('tags', 'up', allVisible, noMemory)).toBe('explorer');
    expect(move('frontmatter', 'down', allVisible, noMemory)).toBe('editor');
    expect(move('outline', 'down', allVisible, noMemory)).toBe('backlinks');
  });

  test('clamps at the column edge (no wrap)', () => {
    expect(move('explorer', 'up', allVisible, noMemory)).toBeNull();
    expect(move('tags', 'down', allVisible, noMemory)).toBeNull();
    expect(move('editor', 'down', allVisible, noMemory)).toBeNull();
  });

  test('skips a hidden Region in the column', () => {
    // Tags hidden: down from Explorer has nowhere visible below → clamp.
    expect(move('explorer', 'down', visibleSet('explorer'), noMemory)).toBeNull();
  });
});

describe('move: left/right across columns', () => {
  test('right/left change column, landing on the same row by default', () => {
    expect(move('explorer', 'right', allVisible, noMemory)).toBe('frontmatter');
    expect(move('frontmatter', 'right', allVisible, noMemory)).toBe('outline');
    expect(move('outline', 'left', allVisible, noMemory)).toBe('frontmatter');
    expect(move('editor', 'left', allVisible, noMemory)).toBe('tags');
  });

  test('clamps at the leftmost / rightmost visible column', () => {
    expect(move('explorer', 'left', allVisible, noMemory)).toBeNull();
    expect(move('outline', 'right', allVisible, noMemory)).toBeNull();
  });

  test('skips a column with no visible Region entirely', () => {
    // Editor column (Properties + Editor) hidden: from Explorer, right jumps to
    // the right column (Outline).
    const vis = visibleSet('explorer', 'tags', 'outline', 'backlinks');
    expect(move('explorer', 'right', vis, noMemory)).toBe('outline');
    // And from Outline, left jumps back to Explorer, skipping the empty column.
    expect(move('outline', 'left', vis, noMemory)).toBe('explorer');
  });

  test('falls to the nearest visible row when the preferred row is hidden', () => {
    // From Tags (row 1) moving right; Editor (row 1) hidden, Properties (row 0)
    // visible → land on Properties.
    const vis = visibleSet('tags', 'frontmatter');
    expect(move('tags', 'right', vis, noMemory)).toBe('frontmatter');
  });
});

describe('sticky per-column landing memory', () => {
  test('returns to the column memory Region when visible', () => {
    // Coming from Properties (col 1, row 0) into the right column whose memory
    // is Backlinks (row 1) → land on Backlinks, not the same-row Outline.
    const memory: ReadonlyArray<RegionId | null> = [null, null, 'backlinks'];
    expect(move('frontmatter', 'right', allVisible, memory)).toBe('backlinks');
  });

  test('ignores stale memory for a now-hidden Region', () => {
    const memory: ReadonlyArray<RegionId | null> = [null, null, 'backlinks'];
    const vis = visibleSet('frontmatter', 'outline'); // backlinks hidden
    expect(move('frontmatter', 'right', vis, memory)).toBe('outline');
  });
});

describe('pickColumnLanding', () => {
  test('prefers the same row, then scans the column', () => {
    expect(pickColumnLanding(0, 1, allVisible, null)).toBe('tags');
    expect(pickColumnLanding(0, 0, allVisible, null)).toBe('explorer');
    // Preferred row hidden → fall through to the other row.
    expect(pickColumnLanding(0, 1, visibleSet('explorer'), null)).toBe('explorer');
  });

  test('returns null for a fully hidden column', () => {
    expect(pickColumnLanding(1, 0, visibleSet('explorer'), null)).toBeNull();
  });
});
