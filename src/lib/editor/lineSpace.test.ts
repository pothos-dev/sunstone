import { describe, expect, test } from 'bun:test';
import { bodyLineToFile, fileLineToBody } from './lineSpace';

describe('fileLineToBody', () => {
  test('is the identity without frontmatter', () => {
    expect(fileLineToBody(1, 0)).toBe(1);
    expect(fileLineToBody(12, 0)).toBe(12);
  });

  test('shifts past the frontmatter block', () => {
    // `---\ntype: x\n---\nbody` — 3 frontmatter lines, file line 4 is body line 1.
    expect(fileLineToBody(4, 3)).toBe(1);
    expect(fileLineToBody(10, 6)).toBe(4);
  });

  test('a line inside the frontmatter clamps to body line 1', () => {
    expect(fileLineToBody(1, 6)).toBe(1);
    expect(fileLineToBody(6, 6)).toBe(1);
  });
});

describe('bodyLineToFile', () => {
  test('adds the frontmatter offset', () => {
    expect(bodyLineToFile(1, 0)).toBe(1);
    expect(bodyLineToFile(1, 3)).toBe(4);
    expect(bodyLineToFile(4, 6)).toBe(10);
  });

  test('round-trips every body line', () => {
    for (let line = 1; line <= 20; line++) {
      expect(fileLineToBody(bodyLineToFile(line, 5), 5)).toBe(line);
    }
  });
});
