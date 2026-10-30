import type { PageLoad } from './$types';
import { loadConcept } from '$lib/web/loadConcept';
import { printPageData } from '$lib/print/printData';

/**
 * Concept-by-path load (`/providers`, `/research/providers/mistral-ai`, …).
 *
 * WEB build only: `params.concept` is the pretty, already-decoded path; it is
 * resolved to a real Concept and server-rendered (see `loadConcept`). The
 * root `/` is handled by the sibling `src/routes/+page.ts`. In the DEFAULT
 * desktop/Tauri build the body is dead-code-eliminated (`__SUNSTONE_WEB__` is a
 * compile-time `false`) and this route only exists so the static SPA's client
 * router can match any deep link back to `<App/>` — including the print window,
 * which loads `index.html?print=…` (a `/index.html` pathname that matches here,
 * not the root route), so the `?print=` overlay must be detected here too.
 */
export const load: PageLoad = async ({ fetch, url, params, setHeaders }) => {
  const print = printPageData(url);
  if (print) {
    return print;
  }
  if (!__SUNSTONE_WEB__) {
    return { web: false as const };
  }
  return loadConcept(fetch, params.concept, setHeaders);
};
