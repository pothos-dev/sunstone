// Reserved-file helper (slice: reserved-files).
//
// OKF defines two reserved files with special meaning that are NOT ordinary
// Concepts: `index.md` (progressive-disclosure listing) and `log.md` (dated
// change history). They can appear at ANY directory level. This module is the
// single pure source of truth for detecting them, reused by:
//   - Tree filtering (strip reserved files from the ordinary leaf listing),
//   - per-folder affordances (icons that open the reserved files directly),
//   - the Frontmatter Region's required-`type` exemption,
//   - new-Concept scaffolding (skip the `type` stub for reserved files).
//
// Operates purely on bundle-relative, forward-slash paths — no IPC dependency.

import { basename, joinPath } from './path';

/** The OKF-defined reserved file kinds. */
export type ReservedKind = 'index' | 'log';

/** The reserved file basenames, keyed by kind. */
export const RESERVED_FILES: Record<ReservedKind, string> = {
  index: 'index.md',
  log: 'log.md',
};

/**
 * The small glyph each reserved kind shows as a folder-row / Bundle-root
 * affordance (desktop Explorer, App root listing, web viewer).
 */
export const RESERVED_GLYPH: Record<ReservedKind, string> = { index: '☰', log: '🕑' };

/** Every reserved basename (lowercase), for membership checks. */
const RESERVED_BASENAMES = new Set<string>(Object.values(RESERVED_FILES));

/**
 * Whether `path` names a reserved file (`index.md` or `log.md`) at any level.
 * Case-insensitive on the basename to match OKF's reserved names robustly.
 */
export function isReservedFile(path: string): boolean {
  return RESERVED_BASENAMES.has(basename(path).toLowerCase());
}

/**
 * The reserved kind of `path` (`'index'` / `'log'`), or `null` if it is not a
 * reserved file.
 */
export function reservedKind(path: string): ReservedKind | null {
  const name = basename(path).toLowerCase();
  if (name === RESERVED_FILES.index) return 'index';
  if (name === RESERVED_FILES.log) return 'log';
  return null;
}

/**
 * Join a folder ('' = Bundle root) and a reserved file's basename into a
 * bundle-relative path. Used to address a folder's reserved file when opening
 * or creating it.
 */
export function reservedPath(dir: string, kind: ReservedKind): string {
  return joinPath(dir, RESERVED_FILES[kind]);
}

/**
 * A minimal, spec-valid stub body for a freshly created reserved file. Reserved
 * files are EXEMPT from the required-`type` field, so we keep these frontmatter-
 * free — just a top heading derived from the folder so the file isn't empty.
 */
export function reservedStub(dir: string, kind: ReservedKind): string {
  const folder = dir === '' ? 'Bundle' : (dir.split('/').pop() ?? dir);
  if (kind === 'log') {
    return `# Log — ${folder}\n`;
  }
  return `# ${folder}\n`;
}
