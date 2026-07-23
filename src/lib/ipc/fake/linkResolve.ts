/**
 * Fake-backend link resolution ("Fork B", ADR 0006 family 12).
 *
 * The editor's link twin (`$lib/links.ts`) was deleted in family 10 — the
 * editor now resolves through the wasm `BundleIndex` handle. The FAKE backend,
 * however, is the in-memory twin of the NATIVE backend commands (backlinks,
 * rename/move auto-rewrite): those run corpus-wide over arbitrary OLD/NEW path
 * sets, so they cannot use the live single-buffer handle. This module keeps the
 * pure resolver the fake's command twins need. Family 12 dedupes it against the
 * shared source; until then it stays a fake-scoped fork (NOT `$lib/links.ts`).
 *
 * Byte-identical to the former `src/lib/links.ts` resolvers, so the fake keeps
 * exercising the same behaviour under Playwright.
 */

/** The resolved kind of a markdown link (fake engine — no `exists` field). */
export type ResolvedLink =
  | { kind: 'external'; href: string }
  | { kind: 'internal'; path: string; anchor: string | null }
  | { kind: 'none' };

/** Matches a URL scheme like `http:`, `https:`, `mailto:`, `tel:`. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/** True for links handled by the OS/browser, not by in-app navigation. */
export function isExternalLink(href: string): boolean {
  return SCHEME_RE.test(href);
}

/** The three components of a raw wikilink target `name|alias#anchor`. */
export interface WikilinkParts {
  name: string;
  alias: string | null;
  anchor: string | null;
}

/** Split a raw wikilink inner text into `name`, `alias`, and `anchor`. */
export function splitWikilinkTarget(rawTarget: string): WikilinkParts {
  let rest = rawTarget;
  let alias: string | null = null;
  const pipe = rest.indexOf('|');
  if (pipe !== -1) {
    alias = rest.slice(pipe + 1);
    rest = rest.slice(0, pipe);
  }
  let anchor: string | null = null;
  const hash = rest.indexOf('#');
  if (hash !== -1) {
    anchor = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  return { name: rest, alias, anchor };
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function stripMd(name: string): string {
  return name.replace(/\.md$/i, '');
}

/** Resolve a wikilink target to a bundle path, or `null` if unresolved. */
export function resolveWikilink(
  allPaths: string[],
  sourcePath: string,
  rawTarget: string,
): { path: string } | null {
  const { name } = splitWikilinkTarget(rawTarget);
  const t = stripMd(name.trim());
  if (t === '') return { path: sourcePath }; // pure same-file anchor [[#heading]]

  const L = t.toLowerCase();
  const candidates = allPaths.filter((p) => p.endsWith('.md'));

  let matches: string[];
  if (t.includes('/')) {
    matches = candidates.filter((c) => {
      const noExt = stripMd(c).toLowerCase();
      return noExt === L || noExt.endsWith(`/${L}`);
    });
  } else {
    matches = candidates.filter((c) => stripMd(basename(c)).toLowerCase() === L);
  }
  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    const da = (a.match(/\//g) ?? []).length;
    const db = (b.match(/\//g) ?? []).length;
    if (da !== db) return da - db;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return { path: matches[0] };
}

/** Normalize a '/'-separated path, collapsing `.` and `..` segments. */
function normalizeSegments(segments: string[]): string {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/** The `#anchor` fragment of a link href (before any `?query`), or null. */
function extractAnchor(href: string): string | null {
  const hash = href.indexOf('#');
  if (hash === -1) return null;
  const frag = href.slice(hash + 1);
  const q = frag.indexOf('?');
  const anchor = q === -1 ? frag : frag.slice(0, q);
  return anchor === '' ? null : anchor;
}

/** Resolve a markdown link `href` clicked inside the Concept at `currentPath`. */
export function resolveLink(currentPath: string, href: string): ResolvedLink {
  const raw = href.trim();
  if (raw === '') return { kind: 'none' };
  if (isExternalLink(raw)) return { kind: 'external', href: raw };
  if (raw.startsWith('#')) return { kind: 'none' };

  const pathPart = raw.split('#')[0].split('?')[0];
  if (pathPart === '') return { kind: 'none' };
  const anchor = extractAnchor(raw);

  if (pathPart.startsWith('/')) {
    const path = normalizeSegments(pathPart.slice(1).split('/'));
    return path === '' ? { kind: 'none' } : { kind: 'internal', path, anchor };
  }

  const dir = dirname(currentPath);
  const dirSegments = dir === '' ? [] : dir.split('/');
  const path = normalizeSegments([...dirSegments, ...pathPart.split('/')]);
  return path === '' ? { kind: 'none' } : { kind: 'internal', path, anchor };
}
