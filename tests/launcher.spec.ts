import { test, expect } from './fixtures';

/**
 * Slice: launcher (+ launcher-filter).
 *
 * Launching Sunstone with no path (`sunstone` alone) shows the launcher: an
 * auto-focused filter box over a list of previously-opened folders, one
 * single-line path per row (most-recent first, each removable), plus an
 * "Open folder…" native picker. Typing fuzzy-filters the list, ↑/↓ step the
 * selection and Enter opens it; a click does the same. Opening a folder opens it
 * in-process and reloads into the editor.
 *
 * The fake backend models launcher mode with `?launcher=1` (currentBundle → null
 * until a folder is opened) and a localStorage-backed known-folder list seeded
 * with three fixtures. This spec drives that to assert:
 *  - the launcher lists the known folder PATHS newest-first,
 *  - the filter box is focused on load and fuzzy-trims the list,
 *  - ↑/↓ move the selection and Enter opens the selected folder,
 *  - the X button forgets a folder (drops it from the list),
 *  - clicking a folder opens it and reloads into the editor (the tree appears),
 *  - the "Open folder…" picker opens the chosen folder into the editor.
 */

/** Fresh launcher state: force launcher mode and clear any prior storage. */
async function gotoLauncher(page: import('./fixtures').Page) {
  await page.goto('/?launcher=1');
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.reload();
}

test('lists known folder paths newest-first, forgets one, and opens into the editor', async ({
  page,
}) => {
  await gotoLauncher(page);

  const launcher = page.getByTestId('launcher');
  await expect(launcher).toBeVisible();

  // Seeded, newest-first: Knowledge Base (3000) → Project Notes (2000) → Archive (1000).
  // Each row is the full path on a single line.
  const items = page.getByTestId('launcher-item');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText('/home/user/Knowledge Base');
  await expect(items.nth(1)).toContainText('/home/user/Project Notes');
  await expect(items.nth(2)).toContainText('/home/user/Archive');

  await page.screenshot({ path: 'tests/screenshots/launcher.png' });

  // Forget the middle folder → it drops out of the list, others remain.
  await page
    .locator('[data-testid="launcher-forget"][data-path="/home/user/Project Notes"]')
    .click();
  await expect(items).toHaveCount(2);
  await expect(page.getByText('Project Notes')).toHaveCount(0);

  // Open a folder → the editor loads (the Explorer tree appears) and the launcher
  // is gone. The reload keeps `?launcher=1`, but the fake now reports the opened
  // Bundle as current, so DesktopShell lands on <App/>.
  await items.nth(0).click();
  await expect(page.getByTestId('tree')).toBeVisible();
  await expect(page.getByTestId('launcher')).toHaveCount(0);
});

test('the filter box is focused on load and fuzzy-trims the list', async ({ page }) => {
  await gotoLauncher(page);

  const filter = page.getByTestId('launcher-filter');
  await expect(filter).toBeFocused();

  const items = page.getByTestId('launcher-item');
  await expect(items).toHaveCount(3);

  // A fuzzy (non-contiguous) query keeps only the folders whose PATH matches.
  await page.keyboard.type('arv');
  await expect(items).toHaveCount(1);
  await expect(items.nth(0)).toHaveAttribute('data-path', '/home/user/Archive');

  // A query nothing matches shows the empty-result line.
  await filter.fill('zzzz');
  await expect(items).toHaveCount(0);
  await expect(page.getByTestId('launcher-no-matches')).toBeVisible();

  // Escape clears the filter and restores the full list.
  await page.keyboard.press('Escape');
  await expect(filter).toHaveValue('');
  await expect(items).toHaveCount(3);
});

test('↑/↓ move the selection and Enter opens the selected folder', async ({ page }) => {
  await gotoLauncher(page);

  const items = page.getByTestId('launcher-item');
  await expect(items).toHaveCount(3);

  // The first row starts selected; ↓↓ lands on the third, ↑ steps back to the second.
  const options = page.locator('#launcher-list [role="option"]');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(items.nth(1)).toHaveAttribute('data-path', '/home/user/Project Notes');

  // Enter opens the selected folder → reload into the editor.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tree')).toBeVisible();
  await expect(page.getByTestId('launcher')).toHaveCount(0);
});

test('typing then Enter opens the best match', async ({ page }) => {
  await gotoLauncher(page);
  await expect(page.getByTestId('launcher-item')).toHaveCount(3);

  await page.keyboard.type('arch');
  await expect(page.getByTestId('launcher-item')).toHaveCount(1);
  await page.keyboard.press('Enter');

  await expect(page.getByTestId('tree')).toBeVisible();
  // The opened folder is the one the filter narrowed to.
  const opened = await page.evaluate(() =>
    window.sessionStorage.getItem('sunstone:fakeOpenBundle'),
  );
  expect(opened).toBe('/home/user/Archive');
});

test('the "Open folder…" picker opens the chosen folder into the editor', async ({ page }) => {
  await gotoLauncher(page);
  await expect(page.getByTestId('launcher')).toBeVisible();

  // The fake picker returns a canned path; opening it reloads into the editor.
  await page.getByTestId('launcher-open-folder').click();
  await expect(page.getByTestId('tree')).toBeVisible();
  await expect(page.getByTestId('launcher')).toHaveCount(0);
});
