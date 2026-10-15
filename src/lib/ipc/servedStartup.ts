// The deep link `sunstone serve` opens with (pure; no DOM/IPC).
//
// Under `sunstone serve` the page URL plays the part the command line plays for
// the desktop window (`sunstone ./docs guide/setup.md#install`): it names the
// Concept to open into the restored active Tile. Two spellings resolve:
//
//   /guide/setup#install      the pretty URL Sunstone Web uses (`conceptToUrl`)
//   /guide/setup.md#install   the Concept's Bundle path, as copied from the repo
//
// The root (`/`, `/index.html`) names nothing, so the restored layout stands.

import type { StartupDocument } from '$lib/types';

/** What the page URL asks the served desktop shell to open. */
export type StartupLink =
  | { kind: 'open'; doc: StartupDocument }
  /** The URL names a path with no Concept behind it: report it, open nothing. */
  | { kind: 'missing'; urlPath: string }
  | null;

/**
 * Resolve `pathname` + `hash` (raw, percent-encoded, as on `location`) against
 * the Bundle's Concept paths. `urlToConcept` is the pretty-URL rule
 * (`BundleIndex.urlToConcept` over the same paths; a folder `index.md` wins over
 * a same-named leaf); a path ending in `.md` is taken literally instead.
 */
export function startupFromUrl(
  pathname: string,
  hash: string,
  conceptPaths: readonly string[],
  urlToConcept: (urlPath: string) => string | null,
): StartupLink {
  const urlPath = decode(pathname).replace(/^\/+|\/+$/g, '');
  if (urlPath === '' || urlPath === 'index.html') return null;
  const path = /\.md$/i.test(urlPath)
    ? conceptPaths.find((p) => p === urlPath) ?? null
    : urlToConcept(urlPath);
  if (path === null) return { kind: 'missing', urlPath: `/${urlPath}` };
  const anchor = decode(hash.replace(/^#/, ''));
  return { kind: 'open', doc: { path, anchor: anchor === '' ? null : anchor } };
}

/**
 * The address-bar URL (path + hash) the served desktop shell writes for the
 * active Tile's `concept`, or `null` when it cannot tell yet (the Concept is not
 * in `conceptPaths`, e.g. before the index loads): leave the URL alone then.
 *
 * Binding: whatever this returns resolves back to `concept` through
 * {@link startupFromUrl}, so a reload or a copied link lands on it.
 *   - The pretty URL (`conceptToUrl`) when it round-trips and its last segment
 *     has no dot.
 *   - Otherwise the Bundle path (`/release-1.2.md`, `/v1.0/index.md`,
 *     `/guide.md` beside `guide/index.md`): `sunstone serve` 404s a missing
 *     dotted path that is not `.md` (`is_spa_route`), and a leaf shadowed by a
 *     same-named folder index has no other spelling.
 *   - The root Concept keeps `/`, which names the Bundle's front page.
 * `current` is the page URL now (raw `location.pathname` / `hash`). Its hash is
 * kept when that URL already names `concept` (the `.md` → pretty rewrite of the
 * deep link the page opened with), and dropped for any other Concept.
 */
export function servedAddress(
  concept: string | null,
  current: { pathname: string; hash: string },
  conceptPaths: readonly string[],
  urlToConcept: (urlPath: string) => string | null,
  conceptToUrl: (path: string) => string,
): string | null {
  if (concept === null) return '/';
  const names = (pathname: string): string | null => {
    const link = startupFromUrl(pathname, '', conceptPaths, urlToConcept);
    return link?.kind === 'open' ? link.doc.path : null;
  };
  const pretty = conceptToUrl(concept);
  const lastSegment = decode(pretty).split('/').pop() ?? '';
  let href: string;
  if (pretty === '/' || (!lastSegment.includes('.') && names(pretty) === concept)) {
    href = pretty;
  } else {
    href = '/' + concept.split('/').map(encodeURIComponent).join('/');
    if (names(href) !== concept) return null;
  }
  const hash = current.hash.length > 1 && names(current.pathname) === concept ? current.hash : '';
  return href + hash;
}

/** `decodeURIComponent`, keeping a malformed escape (`%zz`) as written. */
function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
