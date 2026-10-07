import type { PageLoad } from './$types';
import { loadConcept } from '$lib/web/loadConcept';
import { printPageData } from '$lib/print/printData';

/**
 * Root-page load (`/`).
 *
 * Print/PDF preview overlay (`?print=<bundle-path>`): opened in its OWN
 * window/tab (a chrome-free browser tab on web, a separate Tauri window on
 * desktop — see `Backend.openPrintWindow`). Detected FIRST so it works on both
 * targets and short-circuits the normal home/wiki load; `PrintView` renders the
 * Concept client-side. `?toolbar=1` shows the desktop reader controls.
 *
 * Otherwise, in the WEB build this resolves to the Bundle's root `index.md` (the
 * wiki home) — pretty URLs address a Concept by its path, so the root is the
 * empty path. Nested Concepts are served by the `[...concept]` route; both share
 * `loadConcept`. In the DEFAULT (desktop/Tauri) build `__SUNSTONE_WEB__` is a
 * compile-time `false`, so the body is dead-code-eliminated and the static SPA
 * is untouched (never hits `/_api`).
 */
export const load: PageLoad = async ({ fetch, url }) => {
  const print = printPageData(url);
  if (print) {
    return print;
  }
  if (!__SUNSTONE_WEB__) {
    return { web: false as const };
  }
  return loadConcept(fetch, '');
};
