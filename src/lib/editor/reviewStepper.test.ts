// Unit tests for the review-diff history stepper index math. Run with
// `bun test src/lib`.
import { describe, expect, test } from 'bun:test';
import { reviewStep, maxStep } from './reviewStepper';
import type { FileCommit } from '$lib/types';

/** Three-commit history (newest first), like `Backend.fileHistory` returns. */
const commits: FileCommit[] = [
  { hash: 'aaa1111', subject: 'Newest', author: 'A', date: '2026-07-19', relativeDate: 'yesterday' },
  { hash: 'bbb2222', subject: 'Middle', author: 'B', date: '2026-07-10', relativeDate: '10 days ago' },
  { hash: 'ccc3333', subject: 'Oldest', author: 'C', date: '2026-07-01', relativeDate: '3 weeks ago' },
];

describe('maxStep', () => {
  test('is one less than the commit count', () => {
    expect(maxStep(commits)).toBe(2);
  });
  test('a single commit yields only position 0', () => {
    expect(maxStep(commits.slice(0, 1))).toBe(0);
  });
  test('no commits yields position 0', () => {
    expect(maxStep([])).toBe(0);
  });
});

describe('reviewStep', () => {
  test('position 0 is Working tree ↔ HEAD, newer side is the working tree (no commit)', () => {
    const step = reviewStep(commits, 0);
    expect(step.oldRev).toBe('HEAD');
    expect(step.newRev).toBeNull();
    expect(step.label).toBe('Working tree ↔ HEAD');
    expect(step.newer).toBeNull();
    expect(step.canNewer).toBe(false); // already at the working tree
    expect(step.canOlder).toBe(true); // history exists
  });

  test('position 1 diffs the two newest commits by hash, newest on the newer side', () => {
    const step = reviewStep(commits, 1);
    expect(step.newRev).toBe('aaa1111'); // commits[0]
    expect(step.oldRev).toBe('bbb2222'); // commits[1]
    expect(step.label).toBe('aaa1111 ↔ bbb2222');
    expect(step.newer).toBe(commits[0]);
    expect(step.canNewer).toBe(true);
    expect(step.canOlder).toBe(true);
  });

  test('position 2 diffs the middle/oldest commits by hash, middle on the newer side', () => {
    const step = reviewStep(commits, 2);
    expect(step.newRev).toBe('bbb2222'); // commits[1]
    expect(step.oldRev).toBe('ccc3333'); // commits[2]
    expect(step.label).toBe('bbb2222 ↔ ccc3333');
    expect(step.newer).toBe(commits[1]);
    expect(step.canNewer).toBe(true);
    expect(step.canOlder).toBe(false); // oldest pair — bounded
  });

  test('clamps an out-of-range position into the valid range', () => {
    expect(reviewStep(commits, 99)).toEqual(reviewStep(commits, 2));
    expect(reviewStep(commits, -5)).toEqual(reviewStep(commits, 0));
  });

  test('a single-commit history bounds both directions at position 0', () => {
    const step = reviewStep(commits.slice(0, 1), 0);
    expect(step.canOlder).toBe(false);
    expect(step.canNewer).toBe(false);
    expect(step.label).toBe('Working tree ↔ HEAD');
  });
});
