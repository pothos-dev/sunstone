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

// Search hits carry the FILE's line (frontmatter included) but the editor holds
// only the body, so the hit line must be shifted past the frontmatter block —
// both when the result opens a new Concept and when it is already open.
test('full-text search: a hit in a Concept with frontmatter lands on its own line', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  const panel = page.getByTestId('search-panel');
  const editor = page.getByTestId('editor');

  // --- Opening the Concept from the hit (pending-scroll path) ---
  await page.keyboard.press('Control+Shift+F');
  await expect(panel).toBeVisible();
  await page.getByTestId('search-input').fill('pomegranate line 20');
  const hit = panel.locator('[data-path="concepts/search-overflow.md"]');
  await expect(hit).toHaveCount(1);
  await hit.click();
  await expect(panel).toBeHidden();
  // Read is the default; the active-line highlight (which marks where the
  // search put the cursor) is an editing-only extension.
  await page.getByTestId('edit-toggle').click();
  await expect(editor.locator('.cm-activeLine')).toContainText('pomegranate line 20');

  // --- Choosing a hit in the Concept that is already open ---
  await page.keyboard.press('Control+Shift+F');
  await expect(panel).toBeVisible();
  await page.getByTestId('search-input').fill('pomegranate line 05');
  await expect(hit).toHaveCount(1);
  await hit.click();
  await expect(panel).toBeHidden();
  await expect(editor.locator('.cm-activeLine')).toContainText('pomegranate line 05');
});
