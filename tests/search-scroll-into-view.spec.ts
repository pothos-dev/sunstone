import { test, expect } from './fixtures';
import { type Locator } from '@playwright/test';

/**
 * Slice: full-text-search (keyboard-navigation scroll-into-view).
 *
 * Regression guard for: navigating the cross-Bundle Search panel results with
 * the ↑/↓ arrow keys could move the highlighted selection OUTSIDE the visible
 * scroll viewport of the capped-height results list — the list did not scroll
 * the selected row back into view. Driving ArrowDown past the bottom (and
 * ArrowUp wrapping to the end / top) must keep the selected row visible.
 *
 * The fake backend's `concepts/search-overflow.md` supplies many lines matching
 * the distinctive word "pomegranate" so the result list overflows.
 */

/** True when `el`'s vertical bounds sit (roughly) within `container`'s bounds. */
async function selectedIsVisibleIn(container: Locator, el: Locator): Promise<boolean> {
  const cb = await container.boundingBox();
  const eb = await el.boundingBox();
  if (!cb || !eb) return false;
  // Allow a 1px fudge for sub-pixel rounding of scroll offsets.
  return eb.y >= cb.y - 1 && eb.y + eb.height <= cb.y + cb.height + 1;
}

test('full-text search: arrow navigation keeps the selection scrolled into view', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();

  await page.keyboard.press('Control+Shift+F');
  const panel = page.getByTestId('search-panel');
  await expect(panel).toBeVisible();

  // A query that returns far more hits than fit in the capped result list.
  await page.getByTestId('search-input').fill('pomegranate');

  const results = page.getByTestId('search-results');
  const items = panel.getByTestId('search-item');
  // Sanity: the result set must overflow the viewport for this test to mean
  // anything. There are 30 matching lines in concepts/search-overflow.md.
  await expect(items).toHaveCount(30);

  // The list must actually be scrollable (content taller than the viewport),
  // otherwise the test would pass trivially.
  const overflows = await results.evaluate((ul) => ul.scrollHeight > ul.clientHeight + 1);
  expect(overflows).toBe(true);

  const selected = panel.locator('.fts-item.selected');

  // Press ArrowDown enough times to move well past the bottom of the viewport.
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('ArrowDown');
  }
  await expect(selected).toBeVisible();
  expect(await selectedIsVisibleIn(results, selected)).toBe(true);

  // Wrap around the bottom back to the top via ArrowDown.
  for (let i = 20; i < 30; i++) {
    await page.keyboard.press('ArrowDown');
  }
  // Now wrapped to index 0; selection must be visible at the top.
  expect(await selectedIsVisibleIn(results, selected)).toBe(true);

  // ArrowUp wraps from the top to the last item; it must scroll into view.
  await page.keyboard.press('ArrowUp');
  await expect(selected).toBeVisible();
  expect(await selectedIsVisibleIn(results, selected)).toBe(true);
});
