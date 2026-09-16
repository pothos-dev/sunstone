import { test, expect } from './fixtures';

/**
 * Slice: quick-nav-palette.
 *
 * Drives the Ctrl+K command palette against the fake backend:
 *  - Ctrl+K opens it; typing a fragment fuzzy-matches a Concept path; Enter
 *    opens the highlighted match (through editor navigation/history).
 *  - With EMPTY input the palette shows recent files, most-recent first;
 *    arrow + Enter opens one.
 *  - Recent files persist across a reload (localStorage-backed fake = the real
 *    OS-config persistence path).
 */

test('quick-nav: fuzzy match, recent files, persistence', async ({ page }) => {
  await page.goto('/');

  let tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // Clean slate so recent files start empty and deterministic.
  await page.evaluate(() => window.localStorage.setItem('sunstone:bundleState:/fake/bundle', JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'] })));
  await page.reload();
  tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // --- Fuzzy match + Enter opens through navigation ---
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('quick-nav');
  await expect(palette).toBeVisible();

  // "codem" fuzzy-matches concepts/codemirror.md. (It ALSO surfaces the
  // `codemirror` tag — tags are mixed into results now — so click the Concept
  // row directly rather than pressing Enter, which would drill into the tag.)
  await page.getByTestId('quick-nav-input').fill('codem');
  const codemirror = palette.locator('[data-path="concepts/codemirror.md"]');
  await expect(codemirror).toBeVisible();

  await codemirror.click();
  await expect(palette).toBeHidden();
  await expect(page.getByTestId('editor')).toContainText('CodeMirror 6 is the editor core');

  // Open a second Concept via the palette so we have two recents.
  await page.keyboard.press('Control+k');
  await page.getByTestId('quick-nav-input').fill('bundle');
  const bundleItem = palette.locator('[data-path="concepts/bundle.md"]');
  await expect(bundleItem).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('editor')).toContainText('is the root folder opened by Sunstone');

  // --- Empty input shows recent files, most-recent first ---
  await page.keyboard.press('Control+k');
  await expect(palette).toBeVisible();
  await expect(page.getByTestId('quick-nav-hint')).toHaveText('Recent files');

  const recentPaths = await palette
    .getByTestId('quick-nav-item')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-path')));
  // Most-recent first: bundle (opened last) before codemirror.
  expect(recentPaths.slice(0, 2)).toEqual(['concepts/bundle.md', 'concepts/codemirror.md']);

  await page.screenshot({ path: 'tests/screenshots/quick-nav.png', fullPage: true });

  // ArrowDown selects the second recent (codemirror); Enter opens it.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page.getByTestId('editor')).toContainText('CodeMirror 6 is the editor core');

  // --- Recent files persist across reload ---
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('sunstone:bundleState:/fake/bundle');
        return raw ? (JSON.parse(raw) as { recentFiles?: string[] }).recentFiles ?? null : null;
      }),
    )
    .toEqual(['concepts/codemirror.md', 'concepts/bundle.md']);

  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();

  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('quick-nav')).toBeVisible();
  const afterReload = await page
    .getByTestId('quick-nav')
    .getByTestId('quick-nav-item')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-path')));
  expect(afterReload.slice(0, 2)).toEqual(['concepts/codemirror.md', 'concepts/bundle.md']);
});

/**
 * Slice: quick-nav tag surfacing + drill-down.
 *
 *  - Typing surfaces matching tags alongside Concepts (a tag row, badged).
 *  - Choosing a tag DRILLS IN: the list is replaced by the Concepts carrying it
 *    (rendered like normal Concept rows), and opening one navigates.
 *  - Escape steps back OUT of the tag to the normal search before it closes the
 *    palette (the unified Escape peel defers to the drill-down).
 */
test('quick-nav: surfaces tags and drills into a tag; Escape steps back', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();

  const palette = page.getByTestId('quick-nav');

  // Typing surfaces a matching tag alongside Concepts. The `editor` tag rides on
  // two Concepts in the fixture (codemirror + editor/live-preview).
  await page.keyboard.press('Control+k');
  await expect(palette).toBeVisible();
  await page.getByTestId('quick-nav-input').fill('editor');
  const tagRow = palette.locator('[data-testid="quick-nav-tag"][data-tag="editor"]');
  await expect(tagRow).toBeVisible();

  // Drill in: the list is replaced by the Concepts carrying the tag (no nested
  // tag rows), and a tag-mode hint appears.
  await tagRow.click();
  await expect(palette.getByTestId('quick-nav-tag-hint')).toBeVisible();
  await expect(palette.getByTestId('quick-nav-tag')).toHaveCount(0);
  await expect(palette.locator('[data-path="concepts/codemirror.md"]')).toBeVisible();
  await expect(palette.locator('[data-path="concepts/editor/live-preview.md"]')).toBeVisible();

  // Escape steps OUT of the tag back to the normal search — the palette stays open.
  await page.keyboard.press('Escape');
  await expect(palette).toBeVisible();
  await expect(palette.getByTestId('quick-nav-tag-hint')).toBeHidden();
  await expect(palette.getByTestId('quick-nav-hint')).toHaveText('Recent files');

  // A second Escape closes the palette.
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();

  // Drilling in again and opening a tagged Concept navigates to it.
  await page.keyboard.press('Control+k');
  await page.getByTestId('quick-nav-input').fill('editor');
  await palette.locator('[data-testid="quick-nav-tag"][data-tag="editor"]').click();
  await palette.locator('[data-path="concepts/codemirror.md"]').click();
  await expect(palette).toBeHidden();
  await expect(page.getByTestId('editor')).toContainText('CodeMirror 6 is the editor core');
});
