import { test, expect } from './fixtures';

/**
 * ov-11 in the web viewer: a Concept past its `stale_after` (the fixture's
 * `guide/topic.md`, `status: deprecated`, stale since 2000) is marked stale in
 * the Tile header's metadata pill and its Explorer row, and still reads normally. A Concept
 * with neither lifecycle key shows nothing.
 */
test('a stale Concept is marked in the header and the Explorer, and still reads', async ({ page }) => {
  await page.goto('/guide/topic');
  const rendered = page.getByTestId('rendered');
  await expect(rendered.locator('h1')).toContainText('Topic');
  await expect(rendered).toContainText('A guide topic Concept');

  // The header's metadata pill (ov-24): the stale segment, the status in its popover.
  const header = page.getByTestId('tile-header');
  await expect(header.getByTestId('meta-pill-lifecycle')).toHaveText('stale');
  // Hover after hydration (the Tags Section renders from an onMount fetch).
  await expect(page.getByTestId('tags-section')).toBeVisible();
  await header.getByTestId('meta-pill').hover();
  await expect(page.getByTestId('meta-popover-lifecycle').locator('.mp-status')).toHaveText('deprecated');
  await page.mouse.move(5, 600);

  // Folders open collapsed: expand `guide` to see the row — after hydration
  // (the Tags Section renders from an onMount fetch; see web-sources.spec.ts).
  await expect(page.getByTestId('tags-section')).toBeVisible();
  await page.getByTestId('tree-dir').filter({ hasText: 'Guide' }).getByRole('button', { name: 'Guide' }).click();
  const row = page.locator('[data-testid="tree-concept"][data-path="guide/topic.md"]');
  await expect(row).toBeVisible();
  await expect(row.getByTestId('lifecycle-stale')).toBeVisible();
});

test('a Concept with neither key shows no lifecycle affordance', async ({ page }) => {
  await page.goto('/good');
  await expect(page.getByTestId('rendered').locator('h1')).toContainText('Good Concept');
  await expect(page.getByTestId('tile-title')).toBeVisible();
  await expect(page.locator('[data-testid="tree-concept"][data-path="good.md"]').getByTestId('lifecycle')).toHaveCount(0);
  await expect(page.getByTestId('lifecycle')).toHaveCount(0);
  await expect(page.getByTestId('meta-pill')).toHaveCount(0);
});
