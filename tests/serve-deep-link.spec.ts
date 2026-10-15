import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './fixtures';
import { SERVE_BUNDLE_DIR } from './serve-bundle';

/**
 * `sunstone serve` deep links: the page URL names the Concept to open, either
 * as the pretty URL Sunstone Web uses or as the Concept's Bundle path, and the
 * address bar then follows the active Tile so a copied URL links back to it.
 */

const editor = (page: import('@playwright/test').Page) => page.getByTestId('editor');

// Concepts whose pretty URL does not reload them (sl-1), written beside the
// fixture for this file only: a dot in the last segment (the server 404s a
// missing dotted path that is not `.md`) and a leaf shadowed by the same-named
// `guide/index.md`.
const EXTRA: Record<string, string> = {
  'release-1.2.md': '# Release 1.2\n\nThe dotted release notes Concept.\n',
  'v1.0/index.md': '# Version 1.0\n\nThe dotted version folder index.\n',
  'guide.md': '# Guide leaf\n\nThe leaf beside the guide folder.\n',
};

test.beforeAll(() => {
  for (const [path, body] of Object.entries(EXTRA)) {
    const file = join(SERVE_BUNDLE_DIR, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, body);
  }
});

test.afterAll(() => {
  for (const path of Object.keys(EXTRA)) rmSync(join(SERVE_BUNDLE_DIR, path), { force: true });
  rmSync(join(SERVE_BUNDLE_DIR, 'v1.0'), { recursive: true, force: true });
});

test('a pretty URL opens its Concept', async ({ page }) => {
  await page.goto('/guide/topic');
  await expect(editor(page)).toContainText('A guide topic Concept');
});

test('a folder URL opens the folder index', async ({ page }) => {
  await page.goto('/guide');
  await expect(editor(page)).toContainText('The guide section index page');
});

test('a Bundle path opens its Concept, and the URL turns pretty but keeps the anchor', async ({ page }) => {
  await page.goto('/guide/topic.md#topic');
  await expect(editor(page)).toContainText('A guide topic Concept');
  await expect(page).toHaveURL(/\/guide\/topic#topic$/);

  await page.getByTestId('tree').locator('[data-path="good.md"]').click();
  await expect(editor(page)).toContainText('Some bold text');
  await expect(page).toHaveURL(/\/good$/);
});

// A folder's name opens its `index.md`, so `v1.0` is clicked by its folder name.
for (const [path, row, text] of [
  ['release-1.2.md', '[data-path="release-1.2.md"]', 'The dotted release notes Concept'],
  ['v1.0/index.md', '.name-toggle:has-text("v1.0")', 'The dotted version folder index'],
] as const) {
  test(`a dotted Concept (${path}) reloads from the address bar`, async ({ page }) => {
    await page.goto('/good');
    await expect(editor(page)).toContainText('Some bold text');
    await page.getByTestId('tree').locator(row).click();
    await expect(editor(page)).toContainText(text);
    await expect(page).toHaveURL(new RegExp(`/${path.replace(/\./g, '\\.')}$`));

    const response = await page.reload();
    expect(response?.status()).toBe(200);
    await expect(editor(page)).toContainText(text);
  });
}

test('a leaf shadowed by a same-named folder index reloads itself', async ({ page }) => {
  await page.goto('/good');
  await expect(editor(page)).toContainText('Some bold text');
  await page.getByTestId('tree').locator('[data-path="guide.md"]').click();
  await expect(editor(page)).toContainText('The leaf beside the guide folder');
  await expect(page).toHaveURL(/\/guide\.md$/);

  await page.reload();
  await expect(editor(page)).toContainText('The leaf beside the guide folder');
});

test('the address bar follows the active Tile', async ({ page }) => {
  await page.goto('/guide/topic');
  await expect(editor(page)).toContainText('A guide topic Concept');
  await page.getByTestId('tree').locator('[data-path="good.md"]').click();
  await expect(editor(page)).toContainText('Some bold text');
  await expect(page).toHaveURL(/\/good$/);

  await page.reload();
  await expect(editor(page)).toContainText('Some bold text');
});

test('a URL with no Concept behind it says so', async ({ page }) => {
  await page.goto('/guide/nope');
  await expect(page.getByTestId('rewrite-toast')).toHaveText('No Concept at /guide/nope');
  await expect(page.getByTestId('tree')).toBeVisible();
});
