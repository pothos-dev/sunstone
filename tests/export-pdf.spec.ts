import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * Export as PDF → print/PDF preview window (Layer 3).
 *
 * The desktop reading view is CodeMirror (virtualized), so it can't be printed
 * directly. The Export-as-PDF button (and Ctrl+P) now open a SEPARATE, chrome-
 * free print/PDF preview in its own window/tab (`backend.openPrintWindow`),
 * which renders the open Concept via `backend.renderConcept` and offers reader
 * controls (font size, margins) plus Print / Save-as-PDF — so the PDF can be
 * inspected before saving. On the desktop this is a native window; under the
 * fake backend (Chromium/Playwright) it is a new tab at `/?print=<path>&toolbar=1`.
 *
 * Two surfaces exercised:
 *   - the desktop shell opens the preview WITH the reader toolbar (`toolbar=1`);
 *   - the preview itself (`PrintView`) rendered directly for a fixture Concept:
 *     toolbar variant (controls + Print button) and the bare web variant (no
 *     toolbar, auto-invokes the browser's print → Save-as-PDF preview).
 *
 * `window.print` is stubbed via `addInitScript` (headless Chromium has no print
 * dialog); the stub just records a call count.
 */

type FakeWindow = Window & {
  __sunstoneFake: {
    simulateExternalChange: (kind: string, path: string, content?: string) => void;
    files: Record<string, string>;
  };
};

const fm = (title: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n`;

const BODY = `# Export Me\n\nAn ordinary paragraph.\n`;

// A Concept that already lives in the seeded fake Bundle (so a freshly-loaded
// preview tab can render it), carrying CriticMarkup to prove the shared render.
const FIXTURE = 'concepts/annotated.md';

async function stubPrint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __printCalls: number }).__printCalls = 0;
    window.print = () => {
      (window as unknown as { __printCalls: number }).__printCalls += 1;
    };
  });
}

async function printCalls(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls ?? 0);
}

async function createConcept(page: Page, path: string, body: string): Promise<void> {
  await page.waitForFunction(() => '__sunstoneFake' in window);
  await page.evaluate(
    ([p, b]) => {
      (window as unknown as FakeWindow).__sunstoneFake.simulateExternalChange('created', p, b);
    },
    [path, body] as const,
  );
}

async function openConcept(page: Page, path: string, body: string) {
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await createConcept(page, path, body);
  await expect(tree.locator(`[data-path="${path}"]`)).toBeVisible();
  await tree.locator(`[data-path="${path}"]`).click();
  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  return editor;
}

test('export button is disabled with no Concept open and enabled once one is', async ({
  page,
}) => {
  await page.goto('/');

  const exportBtn = page.getByTestId('export-pdf');
  await expect(exportBtn).toBeVisible();
  // Nothing open on a fresh Bundle → the export affordance is disabled.
  await expect(exportBtn).toBeDisabled();

  await openConcept(page, 'export-me.md', `${fm('Export Me')}${BODY}`);
  await expect(exportBtn).toBeEnabled();
});

test('clicking Export opens the print preview window for the open Concept', async ({ page }) => {
  await page.goto('/');
  await openConcept(page, 'export-me.md', `${fm('Export Me')}${BODY}`);

  const popupPromise = page.waitForEvent('popup');
  await page.getByTestId('export-pdf').click();
  const popup = await popupPromise;

  // Opened the chrome-free preview for THIS Concept, with the desktop toolbar.
  expect(popup.url()).toContain('print=export-me.md');
  expect(popup.url()).toContain('toolbar=1');
});

test('Ctrl+P opens the print preview window (not the native print)', async ({ page }) => {
  await page.goto('/');
  await openConcept(page, 'export-me.md', `${fm('Export Me')}${BODY}`);

  const popupPromise = page.waitForEvent('popup');
  await page.keyboard.press('ControlOrMeta+p');
  const popup = await popupPromise;

  expect(popup.url()).toContain('print=export-me.md');
  expect(popup.url()).toContain('toolbar=1');
});

test('preview (toolbar) renders the Concept and Print calls window.print', async ({ page }) => {
  await stubPrint(page);
  await page.goto(`/?print=${encodeURIComponent(FIXTURE)}&toolbar=1`);

  // The rendered body: the fixture heading + a CriticMarkup highlight (the fake
  // render emits the same `critic-*` HTML the Rust renderer does).
  const body = page.getByTestId('print-body');
  await expect(body.locator('h1')).toContainText('Annotated');
  await expect(body.locator('.critic-highlight')).toContainText('pre-existing');

  // Reader controls are present: a direct Save-as-PDF button, a Print… button
  // (drives window.print once), and the margin selector.
  await expect(page.getByTestId('save-pdf')).toBeEnabled();
  await expect(page.getByTestId('margin-select')).toBeVisible();
  const printAction = page.getByTestId('print-action');
  await expect(printAction).toBeEnabled();
  await printAction.click();
  await expect.poll(() => printCalls(page)).toBe(1);

  // Font controls adjust the displayed size.
  await expect(page.getByTestId('font-size')).toHaveText('16px');
  await page.getByTestId('font-inc').click();
  await expect(page.getByTestId('font-size')).toHaveText('17px');

  await page.screenshot({ path: 'tests/screenshots/export-pdf.png', fullPage: true });
});

// The browser shells (fake + web) have no direct PDF export: `savePdf` rejects,
// so Save as PDF falls back to the browser's print dialog (its own Save-as-PDF).
test('Save as PDF falls back to window.print where there is no direct export', async ({
  page,
}) => {
  await stubPrint(page);
  await page.goto(`/?print=${encodeURIComponent(FIXTURE)}&toolbar=1`);
  await expect(page.getByTestId('print-body').locator('h1')).toContainText('Annotated');

  const savePdf = page.getByTestId('save-pdf');
  await expect(savePdf).toBeEnabled();
  expect(await printCalls(page)).toBe(0);
  await savePdf.click();
  await expect.poll(() => printCalls(page)).toBe(1);
  // Nothing was written, so no "Saved to …" confirmation.
  await expect(page.getByText(/Saved to/)).toHaveCount(0);
});

test('preview (web, no toolbar) renders and auto-invokes the browser print', async ({ page }) => {
  await stubPrint(page);
  await page.goto(`/?print=${encodeURIComponent(FIXTURE)}`);

  // No reader toolbar — the browser's native print → Save-as-PDF UI is used.
  await expect(page.getByTestId('print-body').locator('h1')).toContainText('Annotated');
  await expect(page.getByTestId('print-action')).toHaveCount(0);

  // The bare tab hands straight to the browser's print preview on load.
  await expect.poll(() => printCalls(page)).toBe(1);
});

// Following an in-Bundle link inside the preview must open the target IN the
// preview, not escape to the normal app shell. The Rust renderer emits in-Bundle
// links as `<a class="internal-link" data-path="…">`; the fake renderer omits
// link resolution, so we inject that exact anchor markup (the render contract)
// to drive the click delegation.
async function injectLink(page: Page, cls: string, dataPath: string): Promise<void> {
  await page.evaluate(
    ([c, p]) => {
      const body = document.querySelector('[data-testid="print-body"]');
      if (!body) throw new Error('no print-body');
      const a = document.createElement('a');
      a.className = c;
      a.setAttribute('data-path', p);
      if (c.includes('broken')) a.setAttribute('data-broken', 'true');
      a.setAttribute('href', '/should-not-navigate-here');
      a.textContent = 'go';
      a.id = 'injected-link';
      body.appendChild(a);
    },
    [cls, dataPath] as const,
  );
}

test('following an internal link re-renders in the preview, not the app shell', async ({
  page,
}) => {
  await stubPrint(page);
  await page.goto(`/?print=${encodeURIComponent(FIXTURE)}&toolbar=1`);
  await expect(page.getByTestId('print-body').locator('h1')).toContainText('Annotated');

  await injectLink(page, 'internal-link', 'concepts/codemirror.md');
  await page.locator('#injected-link').click();

  // Re-rendered the linked Concept IN PLACE: still the print preview (toolbar
  // present), never the editor/app shell, and the URL never left the print tab.
  await expect(page.getByTestId('print-body').locator('h1')).toContainText('CodeMirror');
  await expect(page.getByTestId('print-view')).toBeVisible();
  await expect(page.getByTestId('margin-select')).toBeVisible();
  await expect(page.getByTestId('editor')).toHaveCount(0);
  expect(page.url()).toContain('print=');
  expect(page.url()).not.toContain('should-not-navigate-here');
});

test('a broken internal link does not navigate', async ({ page }) => {
  await stubPrint(page);
  await page.goto(`/?print=${encodeURIComponent(FIXTURE)}&toolbar=1`);
  await expect(page.getByTestId('print-body').locator('h1')).toContainText('Annotated');

  await injectLink(page, 'internal-link broken', 'missing.md');
  await page.locator('#injected-link').click();

  // No target: stays on the current Concept, no escape to the shell.
  await expect(page.getByTestId('print-body').locator('h1')).toContainText('Annotated');
  await expect(page.getByTestId('print-view')).toBeVisible();
  expect(page.url()).not.toContain('should-not-navigate-here');
});
