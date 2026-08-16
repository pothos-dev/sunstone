/**
 * Shared "the shell IS a plain browser" implementations of the seam's
 * shell-integration methods, used by both browser-hosted backends (`fake` for
 * dev/Playwright, `http` for the web viewer). The Tauri backend is the one
 * with a native shell; these two share the same browser fallbacks:
 *
 *  - print preview opens as a new tab WITH the desktop reader toolbar, so the
 *    desktop print flow stays exercisable without the Tauri shell;
 *  - direct PDF save has no filesystem — a no-op `null` (the browser's native
 *    print → Save-as-PDF UI is the export path);
 *  - "open in default app" is a plain new tab: in a browser, a new tab IS the
 *    default application.
 */

export async function openPrintTab(path: string): Promise<void> {
  window.open(`/?print=${encodeURIComponent(path)}&toolbar=1`, '_blank');
}

export async function noSavePdf(_defaultName: string): Promise<string | null> {
  return null;
}

export async function openExternalTab(url: string): Promise<void> {
  window.open(url, '_blank', 'noopener,noreferrer');
}
