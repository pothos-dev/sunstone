// The fake backend's git fixture: canned, deterministic history + committed
// content so the review-diff UI is testable in plain Chromium with no git.

import type { FileCommit } from '$lib/types';
import { COMMITTED_FILES } from './store';

/**
 * Canned commit history for the fake backend (newest first). Fixed hashes/dates
 * keep the review-diff UI deterministic under Playwright. A MULTI-commit history
 * (issue 05) lets the review-view stepper walk consecutive pairs — position 0 is
 * working tree ↔ HEAD, then HEAD ↔ HEAD~1, HEAD~1 ↔ HEAD~2. Mirrors the real
 * `FileHistory` `ok` shape.
 */
export const FAKE_COMMITS: FileCommit[] = [
  {
    hash: 'a1b2c3d',
    subject: 'Refine the concept',
    author: 'Ada Lovelace',
    date: '2026-07-19T10:00:00+00:00',
    relativeDate: 'yesterday',
  },
  {
    hash: '0f1e2d3',
    subject: 'Expand the details',
    author: 'Grace Hopper',
    date: '2026-07-10T09:00:00+00:00',
    relativeDate: '10 days ago',
  },
  {
    hash: '9a8b7c6',
    subject: 'Initial version',
    author: 'Grace Hopper',
    date: '2026-07-01T09:00:00+00:00',
    relativeDate: '3 weeks ago',
  },
];

/**
 * HEAD-distance of each `FAKE_COMMITS` entry (newest first). The gaps are
 * deliberate: unrelated commits (touching OTHER files) sit BETWEEN this file's
 * own commits, so `HEAD~1` is NOT the file's second-newest version — `HEAD~2`
 * is. This models the real `git log --follow` gap the stepper must diff around:
 * it addresses commits by HASH, never by `HEAD~N`, precisely because `HEAD~N`
 * would resolve unrelated commits to the same (unchanged) file content and show
 * an empty diff. A fake that mapped `HEAD~N → Nth file version` would hide that
 * bug, so it must not.
 */
export const COMMIT_HEAD_DISTANCE = [0, 2, 3];

/**
 * The file-version index a git rev resolves to for THIS file: a `FAKE_COMMITS`
 * short hash → its own index (newest = 0); `HEAD`/`HEAD~N` → the newest file
 * commit at or before that HEAD distance (an unrelated ancestor keeps the file
 * at its previous version), faithful to `git show <rev>:<path>`. `null` when the
 * rev is unrecognized or older than the file's first commit (file absent there).
 */
export function revToVersion(rev: string): number | null {
  const r = rev.trim();
  const idx = FAKE_COMMITS.findIndex((c) => c.hash === r);
  if (idx !== -1) return idx;
  const m = /^HEAD(?:~(\d+))?$/.exec(r);
  if (!m) return null;
  const dist = m[1] ? Number(m[1]) : 0;
  if (dist > COMMIT_HEAD_DISTANCE[COMMIT_HEAD_DISTANCE.length - 1]) return null;
  let version: number | null = null;
  for (let i = 0; i < COMMIT_HEAD_DISTANCE.length; i++) {
    if (COMMIT_HEAD_DISTANCE[i] <= dist) version = i;
  }
  return version;
}

/**
 * Deterministic committed content of `path` at `rev` (the fake's stand-in for
 * `git show <rev>:<path>`), or `null` when the path was never committed or the
 * rev resolves to before the file existed. Version 0 (newest commit) is the
 * COMMITTED snapshot; each older version prepends one UNIQUE marker line PER
 * generation, so every consecutive commit pair yields a distinct, non-empty diff
 * — enough for the history stepper to be exercised end-to-end under Playwright.
 * The working tree is the mutable `FILES`, so the position-0 (working ↔ HEAD)
 * diff stays driven by the user's live edits, exactly as issue 04.
 */
export function committedContentAt(path: string, rev: string): string | null {
  const base = COMMITTED_FILES[path];
  if (base === undefined) return null;
  const version = revToVersion(rev);
  if (version === null) return null;
  if (version === 0) return base;
  const markers: string[] = [];
  for (let g = version; g >= 1; g--) {
    markers.push(`> revision marker ${g} — older wording (generation ${g})`);
  }
  return `${markers.join('\n')}\n\n${base}`;
}
