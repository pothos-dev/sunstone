// Shared in-memory state for the fake backend.
//
// `FILES` / `FOLDERS` are MUTABLE module-level state that every other fake
// module reads and mutates. They are exported as live bindings: because ES
// modules share a single instance per specifier, importing `FILES` here and in
// the tree/link-rewrite modules all refer to the SAME object — there is never a
// second copy. Functions mutate them in place (e.g. `FILES[path] = ...`,
// `FOLDERS.add(...)`); they are never reassigned, so the bindings stay stable.
//
// The seed data itself (the big markdown fixture literal) lives in `./fixture`;
// this module owns the live working-tree state built from it.

import { FIXTURE_FILES } from './fixture';

/** The fake bundle's absolute root path (mirrors a real opened Bundle path). */
export const FAKE_BUNDLE_ROOT = '/fake/bundle';

/**
 * Map of bundle-relative path -> raw markdown content: the mutable WORKING
 * TREE. This IS the fixture object (re-exported, not copied), so `./fixture`
 * and this binding share one instance.
 */
export const FILES: Record<string, string> = FIXTURE_FILES;

/**
 * Snapshot of the fixture at module load — the fake's stand-in for the git
 * COMMITTED (HEAD) state (git seam / review-diff). `FILES` is the mutable
 * WORKING TREE (autosave + runtime `createConcept`/`simulateExternalChange`
 * mutate it); `COMMITTED_FILES` never changes, so `fileAtRev(path, 'HEAD')`
 * returns the original content and a review diff against the edited working tree
 * is stable. A path present in the working tree but ABSENT here was created
 * after the snapshot, so the fake reports it `untracked` — exactly as a real
 * repo reports a never-committed file. String values are immutable, so a shallow
 * copy is a faithful snapshot.
 */
export const COMMITTED_FILES: Record<string, string> = { ...FILES };

/**
 * Explicitly-created folders that contain no `.md` file yet. Folders are
 * normally inferred from file paths, but `createFolder` can make an empty one;
 * we track those here so the tree reflects them (like a real empty directory).
 */
export const FOLDERS = new Set<string>();

/** All `.md` Concept paths currently in the fixture, sorted. */
export function conceptPaths(): string[] {
  return Object.keys(FILES)
    .filter((p) => p.endsWith('.md'))
    .sort();
}

/** Reject paths that escape the bundle, mirroring the Rust validation. */
export function isSafePath(path: string): boolean {
  if (path.startsWith('/')) return false;
  return !path.split('/').includes('..');
}

/** True if `path` is an existing folder (explicit, or implied by a file). */
export function folderExists(path: string): boolean {
  if (FOLDERS.has(path)) return true;
  const prefix = `${path}/`;
  return Object.keys(FILES).some((p) => p.startsWith(prefix));
}

/** True if `path` is an existing file OR folder. */
export function pathExists(path: string): boolean {
  return Object.prototype.hasOwnProperty.call(FILES, path) || folderExists(path);
}
