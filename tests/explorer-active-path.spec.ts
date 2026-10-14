import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';

/**
 * The folders holding the open Concept show expanded in the Explorer — a
 * temporary override on top of each folder's own (persisted) expanded state.
 * Navigating elsewhere folds them back; folders the user expanded stay open.
 */

const row = (page: Page, path: string) => page.locator(`.row[data-row-path="${path}"]`);

async function openViaQuickNav(page: Page, query: string, path: string) {
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('quick-nav');
  await page.getByTestId('quick-nav-input').fill(query);
  await palette.locator(`[data-path="${path}"]`).click();
  await expect(palette).toBeHidden();
}

async function freshLoad(page: Page, expandedFolders: string[]) {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  await page.evaluate(
    (folders) =>
      window.localStorage.setItem(
        'sunstone:bundleState:/fake/bundle',
        JSON.stringify({ expandedFolders: folders, lastOpenConcept: 'index.md' }),
      ),
    expandedFolders,
  );
  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();
}

test('the path to the open Concept is expanded only while it is open', async ({ page }) => {
  await freshLoad(page, []);
  await expect(row(page, 'concepts/codemirror.md')).toHaveCount(0);

  await openViaQuickNav(page, 'live-prev', 'concepts/editor/live-preview.md');
  await expect(row(page, 'concepts/editor/live-preview.md')).toBeVisible();
  await expect(row(page, 'concepts')).toHaveAttribute('aria-expanded', 'true');

  // Navigating to a root-level Concept folds the path back up.
  await page.getByTestId('root-reserved').getByRole('button').first().click();
  await expect(row(page, 'concepts/editor/live-preview.md')).toHaveCount(0);
  await expect(row(page, 'concepts')).toHaveAttribute('aria-expanded', 'false');

  // The persisted expanded set was never touched.
  const stored = await page.evaluate(() =>
    JSON.parse(window.localStorage.getItem('sunstone:bundleState:/fake/bundle') ?? '{}'),
  );
  expect(stored.expandedFolders ?? []).toEqual([]);
});

test('a folder the user expanded stays open after navigating away', async ({ page }) => {
  await freshLoad(page, ['concepts']);

  await openViaQuickNav(page, 'live-prev', 'concepts/editor/live-preview.md');
  await expect(row(page, 'concepts/editor/live-preview.md')).toBeVisible();

  await openViaQuickNav(page, 'codem', 'concepts/codemirror.md');
  await expect(row(page, 'concepts/editor/live-preview.md')).toHaveCount(0);
  await expect(row(page, 'concepts/codemirror.md')).toBeVisible();
});

test('a pinned folder shows an accent twisty; the twisty flips it to user-expanded', async ({
  page,
}) => {
  await freshLoad(page, []);
  await openViaQuickNav(page, 'live-prev', 'concepts/editor/live-preview.md');

  const twisty = row(page, 'concepts').locator('.twisty');
  await expect(twisty).toHaveClass(/pinned/);

  // Clicking it records the user's own expansion: still open, no longer pinned.
  await row(page, 'concepts').locator('.twisty-toggle').click();
  await expect(row(page, 'concepts')).toHaveAttribute('aria-expanded', 'true');
  await expect(twisty).not.toHaveClass(/pinned/);

  // Clicking again drops it back to pinned (held open by the open Concept).
  await row(page, 'concepts').locator('.twisty-toggle').click();
  await expect(twisty).toHaveClass(/pinned/);
});

test('the open index page highlights its folder name', async ({ page }) => {
  await freshLoad(page, []);
  const concepts = row(page, 'concepts');
  await expect(concepts.locator('.name-toggle')).not.toHaveClass(/selected/);

  await concepts.locator('.name-toggle').click();
  await expect(concepts.locator('.name-toggle')).toHaveClass(/selected/);
  await expect(concepts).toHaveAttribute('aria-selected', 'true');
  // Its own index open pins nothing: the folder row itself shows the Concept.
  await expect(concepts.locator('.twisty')).not.toHaveClass(/pinned/);
});
