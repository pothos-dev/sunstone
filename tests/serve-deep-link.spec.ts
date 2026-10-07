import { test, expect } from './fixtures';

/**
 * `sunstone serve` deep links: the page URL names the Concept to open, either
 * as the pretty URL Sunstone Web uses or as the Concept's Bundle path, and the
 * address bar then follows the active Tile so a copied URL links back to it.
 */

const editor = (page: import('@playwright/test').Page) => page.getByTestId('editor');

test('a pretty URL opens its Concept', async ({ page }) => {
  await page.goto('/guide/topic');
  await expect(editor(page)).toContainText('A guide topic Concept');
});

test('a folder URL opens the folder index', async ({ page }) => {
  await page.goto('/guide');
  await expect(editor(page)).toContainText('The guide section index page');
});

test('a Bundle path opens its Concept, and the URL turns pretty', async ({ page }) => {
  await page.goto('/guide/topic.md#topic');
  await expect(editor(page)).toContainText('A guide topic Concept');
  await expect(page).toHaveURL(/\/guide\/topic$/);
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
