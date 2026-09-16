import { test, expect } from './fixtures';

/**
 * Slice: full-text-search.
 *
 * Drives the Ctrl+Shift+F full-text search panel against the fake backend:
 *  - Ctrl+Shift+F opens the panel; typing a term that appears in two Concept
 *    bodies (the distinctive word "marmalade") lists both matches with their
 *    path + snippet.
 *  - Selecting a result opens that Concept (through editor navigation) and the
 *    editor shows the matching content.
 */

test('full-text search: query bodies, list matches, open a result', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // --- Ctrl+Shift+F opens the search panel ---
  await page.keyboard.press('Control+Shift+F');
  const panel = page.getByTestId('search-panel');
  await expect(panel).toBeVisible();

  // --- Typing a distinctive term lists matches across two Concepts ---
  await page.getByTestId('search-input').fill('marmalade');

  const codemirrorHit = panel.locator('[data-path="concepts/codemirror.md"]');
  const bundleHit = panel.locator('[data-path="concepts/bundle.md"]');
  await expect(codemirrorHit).toBeVisible();
  await expect(bundleHit).toBeVisible();

  // Exactly two matches (one per Concept), ordered by path: bundle then codemirror.
  const items = panel.getByTestId('search-item');
  await expect(items).toHaveCount(2);
  const paths = await items.evaluateAll((els) => els.map((e) => e.getAttribute('data-path')));
  expect(paths).toEqual(['concepts/bundle.md', 'concepts/codemirror.md']);

  // The snippet shows the matching line and highlights the term.
  await expect(bundleHit.getByTestId('search-snippet')).toContainText('Marmalade');
  await expect(bundleHit.locator('mark')).toContainText(/marmalade/i);

  await page.screenshot({ path: 'tests/screenshots/full-text-search.png', fullPage: true });

  // --- Selecting a result opens that Concept ---
  await codemirrorHit.click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('editor')).toContainText('CodeMirror 6 is the editor core');
  await expect(page.getByTestId('editor')).toContainText('marmalade');
});
