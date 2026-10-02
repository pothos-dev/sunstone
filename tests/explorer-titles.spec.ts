import { test, expect } from './fixtures';

// Concepts and folders are labelled by their frontmatter `title` (a folder by
// its `index.md`'s); the left rail's titles toggle switches back to filenames.

test('explorer titles: titled Concepts and folders, toggled from the rail', async ({ page }) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  const folder = tree.locator('[data-row-path="concepts"] .name');
  const concept = tree.locator('[data-path="concepts/codemirror.md"]');
  const toggle = page.getByTestId('rail-titles');

  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(folder).toHaveText('Concepts');
  await expect(concept).toHaveText('CodeMirror');

  // The folder's index.md stands for the folder: no duplicate folder crumb.
  await tree.locator('[data-row-path="concepts"] .name-toggle').click();
  await expect(page.getByTestId('tile-title')).toHaveText('Concepts');
  await expect(page.getByTestId('tile-crumb')).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(folder).toHaveText('concepts');
  await expect(concept).toHaveText('codemirror');
  await expect(page.getByTestId('tile-title')).toHaveText('concepts/index');

  // The choice is per-Bundle session state: once the debounced save lands, it
  // survives a reload.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('sunstone:bundleState:/fake/bundle');
        return raw ? ((JSON.parse(raw) as { titlesShown?: boolean }).titlesShown ?? null) : null;
      }),
    )
    .toBe(false);
  await page.reload();
  await expect(page.getByTestId('tree').locator('[data-row-path="concepts"] .name')).toHaveText(
    'concepts',
  );
});
