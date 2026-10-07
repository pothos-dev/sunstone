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

/** `decodeURIComponent`, keeping a malformed escape (`%zz`) as written. */
function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
