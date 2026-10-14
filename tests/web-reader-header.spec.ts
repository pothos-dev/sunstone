import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from './fixtures';
import { WEB_BUNDLE_DIR } from './web-bundle';

/**
 * wr-1: the anonymous web reader renders the desktop `TileHeader` — same title
 * with folder crumbs, same lifecycle — read-only: no Back/Forward (the browser's
 * own), undo/redo, Edit, Save, Review, split or close; the Frontmatter toggle
 * and Export PDF stay. The header is in the SSR HTML.
 */

test('the header is server-rendered with its crumbs and title', async ({ request }) => {
  const html = await (await request.get('/guide/topic')).text();
  expect(html).toContain('data-testid="tile-header"');
  expect(html).toContain('data-testid="tile-crumb"');
  expect(html).toMatch(/data-testid="tile-title"[^>]*>.*Topic/s);
});

test('read-only controls only', async ({ page }) => {
  await page.goto('/guide/topic');
  const header = page.getByTestId('tile-header');
  await expect(header.getByTestId('tile-title')).toContainText('Topic');
  await expect(header.getByTestId('frontmatter-toggle')).toBeVisible();
  await expect(header.getByTestId('export-pdf')).toBeVisible();
  for (const id of ['nav-back', 'nav-forward', 'undo', 'redo', 'save-concept', 'edit-toggle', 'review-toggle', 'split-right', 'split-down', 'tile-close']) {
    await expect(page.getByTestId(id)).toHaveCount(0);
  }
});

test('a crumb with an index.md opens it and reveals the folder', async ({ page }) => {
  await page.goto('/guide/topic');
  // Gate on hydration (the Tags Section renders from an onMount fetch).
  await expect(page.getByTestId('tag-browser')).toBeVisible();
  const crumb = page.getByTestId('tile-crumb');
  await expect(crumb).toHaveText('Guide');
  await crumb.click();
  await expect(page).toHaveURL(/\/guide$/);
  await expect(page.getByTestId('rendered').locator('h1')).toContainText('Guide');
  // The folder is expanded in the Explorer, so its Concepts show.
  await expect(page.locator('[data-testid="tree-concept"][data-path="guide/topic.md"]')).toBeVisible();
});

test('a crumb without an index.md only reveals the folder', async ({ page }) => {
  const dir = join(WEB_BUNDLE_DIR, 'loose');
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, 'leaf.md'), '---\ntype: concept\n---\n\n# Leaf\n\nA Concept in a folder without an index.\n');
    await expect(async () => {
      await page.goto('/loose/leaf');
      await expect(page.getByTestId('rendered').locator('h1')).toContainText('Leaf', { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await expect(page.getByTestId('tag-browser')).toBeVisible();
    const leafRow = page.locator('[data-testid="tree-concept"][data-path="loose/leaf.md"]');
    await expect(leafRow).toHaveCount(0);
    await page.getByTestId('tile-crumb').click();
    await expect(leafRow).toBeVisible();
    await expect(page).toHaveURL(/\/loose\/leaf$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
