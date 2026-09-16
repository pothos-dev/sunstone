import { test, expect } from './fixtures';

/**
 * Slice: hide-tags-section-when-empty.
 *
 * The Tags Section in the left Sidebar is rendered only when the Bundle carries
 * at least one tag — an always-present empty Tags Section is noise. This is
 * driven live by `bundleTags` (reactive on the index `version` signal):
 *  - the default fixture HAS tags, so the Section renders (the visible case);
 *  - stripping every Concept's `tags` frontmatter (via the `clearAllTags` test
 *    hook, which fires ordinary file-changed events) makes the Section vanish
 *    on the next index refresh, with no restart.
 */

type Fake = {
  clearAllTags: () => void;
};

test('Tags Section renders when the Bundle has tags', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();

  // The default fixture carries tags (okf, editor, ...), so the Section exists.
  await expect(page.getByTestId('tags-section')).toBeVisible();

  await page.screenshot({
    path: 'tests/screenshots/hide-tags-section-when-empty-visible.png',
    fullPage: true,
  });
});

test('Tags Section is hidden when the Bundle has no tags', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();

  // Present to begin with (default fixture has tags).
  await expect(page.getByTestId('tags-section')).toBeVisible();

  // Strip every Concept's tags. The fake fires file-changed events, bumping the
  // index `version`; `bundleTags` recomputes to empty and the Section unmounts.
  await page.evaluate(() => {
    (window as unknown as { __sunstoneFake: Fake }).__sunstoneFake.clearAllTags();
  });

  // The Tags Section is gone; the Explorer Section remains.
  await expect(page.getByTestId('tags-section')).toHaveCount(0);
  await expect(page.getByTestId('explorer-section')).toBeVisible();

  await page.screenshot({
    path: 'tests/screenshots/hide-tags-section-when-empty.png',
    fullPage: true,
  });
});
