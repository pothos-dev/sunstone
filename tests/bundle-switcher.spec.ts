import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';

/**
 * Ticket ui-1: switch Bundles without restarting. The left rail's switcher
 * button (and Ctrl+O) opens the known-folder list over the open editor; the
 * fake backend models a switch as the launcher does (mark the folder open,
 * reload), and reports the opened folder as the current Bundle.
 */

const switcher = (page: Page) => page.getByTestId('bundle-switcher');
const items = (page: Page) => page.getByTestId('bundle-switcher-item');

/** The folder the fake backend opened this session (null = the fixture root). */
async function opened(page: Page): Promise<string | null | undefined> {
  try {
    return await page.evaluate(() => window.sessionStorage.getItem('sunstone:fakeOpenBundle'));
  } catch {
    return undefined; // mid-reload
  }
}

/** The bundle-relative path of the Explorer row holding DOM focus. */
function focusedRow(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('data-row-path') ?? null);
}

async function load(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  await page.evaluate(() =>
    window.localStorage.setItem(
      'sunstone:bundleState:/fake/bundle',
      JSON.stringify({ expandedFolders: ['concepts'] }),
    ),
  );
  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();
}

test('the rail button opens a filterable folder list; Escape restores the opener', async ({
  page,
}) => {
  await load(page);
  // Make an Explorer row the opener.
  await page.getByTestId('tree').locator('.row[data-row-path="concepts/bundle.md"]').click();
  await expect.poll(() => focusedRow(page)).toBe('concepts/bundle.md');

  await page.getByTestId('rail-bundle-switcher').click();
  await expect(switcher(page)).toBeVisible();
  await expect(page.getByTestId('bundle-switcher-filter')).toBeFocused();
  await expect(items(page)).toHaveCount(3);
  // The root index title sits over the path, as in the startup launcher.
  await expect(
    page.locator('[data-testid="bundle-switcher-item"][data-path="/home/user/Project Notes"]'),
  ).toContainText('Projektnotizen');

  // Fuzzy filter over title and path, with the match highlighted.
  await page.keyboard.type('arv');
  await expect(items(page)).toHaveCount(1);
  await expect(items(page).nth(0)).toHaveAttribute('data-path', '/home/user/Archive');
  await expect(items(page).nth(0).locator('.hit').first()).toBeVisible();

  // Escape dismisses through the unified peel: nothing switched, focus is back
  // on the Explorer row that opened it.
  await page.keyboard.press('Escape');
  await expect(switcher(page)).toHaveCount(0);
  expect(await opened(page)).toBeNull();
  await expect.poll(() => focusedRow(page)).toBe('concepts/bundle.md');
});

test('Ctrl+O + Enter switches Bundles; the current one is marked and a no-op', async ({ page }) => {
  await load(page);

  await page.keyboard.press('Control+o');
  await expect(switcher(page)).toBeVisible();
  await page.keyboard.type('arch');
  await page.keyboard.press('Enter');

  // The webview reloads into the chosen Bundle.
  await expect.poll(() => opened(page)).toBe('/home/user/Archive');
  await expect(page.getByTestId('tree')).toBeVisible();

  // Reopened, the switcher lists it first, marked current, with no forget ×.
  await page.getByTestId('rail-bundle-switcher').click();
  const current = items(page).nth(0);
  await expect(current).toHaveAttribute('data-path', '/home/user/Archive');
  await expect(current).toHaveAttribute('data-current', 'true');
  await expect(current).toContainText('current');
  await expect(
    page.locator('[data-testid="bundle-switcher-forget"][data-path="/home/user/Archive"]'),
  ).toHaveCount(0);

  // Choosing the current Bundle only closes the popover.
  await current.click();
  await expect(switcher(page)).toHaveCount(0);
  expect(await opened(page)).toBe('/home/user/Archive');

  // A second Ctrl+O toggles it shut again.
  await page.keyboard.press('Control+o');
  await expect(switcher(page)).toBeVisible();
  await page.keyboard.press('Control+o');
  await expect(switcher(page)).toHaveCount(0);
});

test('forget drops a folder; "Open folder…" reaches the picker and switches', async ({ page }) => {
  await load(page);
  await page.getByTestId('rail-bundle-switcher').click();
  await expect(items(page)).toHaveCount(3);

  await page
    .locator('[data-testid="bundle-switcher-forget"][data-path="/home/user/Project Notes"]')
    .click();
  await expect(items(page)).toHaveCount(2);
  await expect(page.getByTestId('bundle-switcher-filter')).toBeFocused();

  // The fake picker answers with a canned folder.
  await page.getByTestId('bundle-switcher-open-folder').click();
  await expect.poll(() => opened(page)).toBe('/home/user/New Bundle');
  await expect(page.getByTestId('tree')).toBeVisible();
});

test('a Concept whose write is held refuses the switch, losing nothing', async ({ page }) => {
  await load(page);
  await page.getByTestId('tree').locator('[data-path="concepts/codemirror.md"]').click();
  await page.getByTestId('frontmatter-toggle').click();
  await page.getByTestId('edit-toggle').click();

  // Break the YAML (drop the `]` closing `tags`): the write is now held.
  const yaml = page.getByTestId('frontmatter').locator('.cm-content');
  await yaml.click();
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await expect(page.getByTestId('save-concept')).toBeVisible({ timeout: 5_000 });

  await page.getByTestId('rail-bundle-switcher').click();
  await items(page).filter({ hasText: 'Archive' }).click();

  // Refused, naming the Concept: no reload, the broken edit is still there.
  await expect(page.getByTestId('bundle-switcher-error')).toContainText('concepts/codemirror.md');
  expect(await opened(page)).toBeNull();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('save-concept')).toBeVisible();
});

test('"New Bundle…" declares the picked folder OKF, rooting it on its own marker', async ({
  page,
}) => {
  // ov-8. The fake serves its fixture whatever folder is open, so "creating" a
  // Bundle declares the fixture's root index.md (which carries other keys).
  await load(page);
  await page.getByTestId('rail-bundle-switcher').click();
  await page.getByTestId('bundle-switcher-new-bundle').click();
  await expect.poll(() => opened(page)).toBe('/home/user/New Bundle');
  await expect(page.getByTestId('tree')).toBeVisible();

  const files = () =>
    page.evaluate(
      () =>
        (window as unknown as { __sunstoneFake: { files: Record<string, string> } }).__sunstoneFake
          .files,
    );
  await expect.poll(async () => (await files())['index.md']).toContain('okf_version: "0.2"');
  const after = await files();
  // The rest of the root index survives; no other index.md gains Frontmatter.
  expect(after['index.md']).toContain('title: Knowledge Base');
  expect(after['index.md']).toContain('# Knowledge Base');
  expect(after['concepts/index.md']).not.toContain('okf_version');

  // The marker is what the root finder reads: the Bundle roots on it.
  const markers = await page.evaluate(() =>
    (
      window as unknown as { __sunstoneBackend: { listOkfMarkers(): Promise<unknown> } }
    ).__sunstoneBackend.listOkfMarkers(),
  );
  expect(markers).toEqual([{ indexPath: 'index.md', okfVersion: '0.2' }]);

  // The root index shows its marker in the Frontmatter Region.
  await page.getByTestId('frontmatter-toggle').click();
  await page.getByTestId('explorer-section-title').click();
  await expect(page.getByTestId('frontmatter')).toContainText('okf_version');
});
