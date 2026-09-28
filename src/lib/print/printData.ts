/**
 * Print/PDF preview overlay detection, shared by the root (`/`) and catch-all
 * (`[...concept]`) page loads.
 *
 * The preview is opened in its OWN window/tab (see `Backend.openPrintWindow`):
 *  - the WEB build opens `/?print=<path>&toolbar=…` — a `/` pathname, matched by
 *    the root route `src/routes/+page.ts`;
 *  - the DESKTOP/Tauri build opens `index.html?print=<path>&toolbar=1` — a
 *    `/index.html` pathname, which the static-SPA client router matches against
 *    the catch-all route `src/routes/[...concept]/+page.ts`.
 *
 * Detecting the param in BOTH loads keeps `PrintView` reachable on every target
 * regardless of which route the client router happens to match; without it the
 * desktop window falls through to the default `<App/>` shell (a second copy of
 * the editor instead of a print preview).
 */
export type PrintPageData = { web: false; print: string; toolbar: boolean };

/**
 * The browser URL of the print/PDF preview for bundle-relative `path`:
 * `/?print=<path>`, plus `&toolbar=1` for the desktop reader controls. The
 * inverse of {@link printPageData}.
 */
export function printUrl(path: string, toolbar = false): string {
  return `/?print=${encodeURIComponent(path)}${toolbar ? '&toolbar=1' : ''}`;
}

export function printPageData(url: URL): PrintPageData | null {
  const print = url.searchParams.get('print');
  if (print === null) return null;
  return {
    web: false,
    print,
    toolbar: url.searchParams.get('toolbar') === '1',
  };
}
