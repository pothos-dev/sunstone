import { readFileSync } from 'node:fs';
import { test, expect, type Page } from './fixtures';

/**
 * User font overrides (`config.json` `fonts`, state/fonts.ts).
 *
 * The fake backend reads the config from `sunstone:fakeAppearance` and serves
 * font files at `/__fake-font/<file>`, which this spec answers with a real
 * woff2. Verifies each role's family and size reach the chrome, the editor
 * prose, the explorer and code, that a listed file is registered and loaded
 * under the role's private face, and that zoom scales the configured sizes.
 */

const WOFF2 = readFileSync('node_modules/@fontsource-variable/jost/files/jost-latin-wght-normal.woff2');

const FONTS = {
  ui: { family: 'Georgia, serif', size: 18 },
  content: { size: 20, files: ['Content.woff2'] },
  code: { family: "'Courier New', monospace", size: 0.8 },
};

async function seed(page: Page): Promise<string[]> {
  const served: string[] = [];
  await page.route('**/__fake-font/**', (route) => {
    served.push(decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()!));
    return route.fulfill({ body: WOFF2, contentType: 'font/woff2' });
  });
  await page.goto('/');
  await page.evaluate((fonts) => {
    window.localStorage.setItem('sunstone:fakeAppearance', JSON.stringify({ fonts }));
  }, FONTS);
  await page.reload();
  await expect(page.locator('#sunstone-appearance')).toBeAttached();
  return served;
}

const fontOf = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const s = getComputedStyle(el);
    return { family: s.fontFamily, size: s.fontSize };
  });

test('each role takes its configured family and size', async ({ page }) => {
  const served = await seed(page);
  await page.getByTestId('tree').locator('[data-path="concepts/codemirror.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('CodeMirror 6 is the editor core');

  // UI: the root size (so every rem) and the chrome family.
  await expect(page.locator('html')).toHaveCSS('font-size', '18px');
  expect((await fontOf(page, 'body')).family).toBe('"Sunstone UI", Georgia, serif');

  // Content: the editor prose and the explorer, in the file-backed face.
  const body = await fontOf(page, '[data-testid="editor"] .cm-line');
  expect(body.size).toBe('20px');
  expect(body.family.startsWith('"Sunstone Content"')).toBe(true);
  expect(await fontOf(page, '[data-path="concepts/codemirror.md"]')).toEqual(body);
  await expect
    .poll(() => page.evaluate(() => document.fonts.check('20px "Sunstone Content"')))
    .toBe(true);
  expect(served).toContain('Content.woff2');

  // Code: the family; the size factor lands as a token the code rules use.
  const html = await page.locator('html').evaluate((el) => ({
    mono: getComputedStyle(el).getPropertyValue('--font-mono').trim(),
    scale: getComputedStyle(el).getPropertyValue('--font-code-scale').trim(),
  }));
  expect(html).toEqual({ mono: "'Sunstone Code', 'Courier New', monospace", scale: '0.8' });
});

test('zoom scales the configured base sizes', async ({ page }) => {
  await seed(page);
  await page.getByTestId('tree').locator('[data-path="concepts/codemirror.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('CodeMirror 6 is the editor core');

  await page.getByTestId('rail-zoom-in').click();
  await expect(page.locator('html')).toHaveCSS('font-size', '19.8px');
  expect((await fontOf(page, '[data-testid="editor"] .cm-line')).size).toBe('22px');

  await page.keyboard.press('Control+0');
  await expect(page.locator('html')).toHaveCSS('font-size', '18px');
});
