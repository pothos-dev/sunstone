import { test, expect, type Page } from './fixtures';

/**
 * The desktop updater's notice (`Backend.onUpdateNotice`) and the release notes
 * shown on the first start after an update (`Backend.takeReleaseNotes`), over
 * the fake's `simulateUpdateNotice` hook and its `?releaseNotes` URL flag.
 */

type Fake = {
  __sunstoneFake: { simulateUpdateNotice(n: { kind: string; version: string; url: string }): void };
};

const URL_ = 'https://github.com/pothos-dev/sunstone/releases/tag/v9.9.0';

/** Record every `window.open` (the fake backend's `openExternal`). */
async function spyOnOpen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const opened: string[] = [];
    (window as unknown as { __opened: string[] }).__opened = opened;
    window.open = ((url?: string | URL) => {
      opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
}

async function raise(page: Page, kind: string): Promise<void> {
  await page.evaluate(
    ([kind, url]) =>
      (window as unknown as Fake).__sunstoneFake.simulateUpdateNotice({
        kind,
        version: '9.9.0',
        url,
      }),
    [kind, URL_],
  );
}

test('an installed update says it runs from the next start, and dismisses', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  await raise(page, 'installed');

  const notice = page.getByTestId('update-notice');
  await expect(notice).toContainText('Sunstone 9.9.0 is installed. It runs from the next start.');
  await expect(page.getByTestId('update-notice-link')).toHaveCount(0);
  await page.getByTestId('update-notice-dismiss').click();
  await expect(notice).toHaveCount(0);
});

test('a package install gets a download link to the release page', async ({ page }) => {
  await spyOnOpen(page);
  await page.goto('/?launcher=1');
  await expect(page.getByTestId('launcher')).toBeVisible();
  await raise(page, 'available');

  await expect(page.getByTestId('update-notice')).toContainText('Sunstone 9.9.0 is available.');
  await page.getByTestId('update-notice-link').click();
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual(
    [URL_],
  );
});

test('the first start after an update shows the release notes once', async ({ page }) => {
  await spyOnOpen(page);
  await page.goto('/?releaseNotes');

  const dialog = page.getByTestId('release-notes');
  await expect(dialog).toContainText('What’s new in Sunstone');
  await expect(dialog.locator('h2')).toHaveText(['9.9.0', '9.8.0']);

  // A link in the notes opens in the browser, not in the app window.
  await dialog.getByRole('link', { name: 'the notes' }).click();
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual(
    ['https://example.com/notes'],
  );

  await page.getByTestId('release-notes-close').click();
  await expect(dialog).toHaveCount(0);
});

test('Escape closes the release notes', async ({ page }) => {
  await page.goto('/?releaseNotes');
  await expect(page.getByTestId('tree')).toBeVisible();
  await expect(page.getByTestId('release-notes')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('release-notes')).toHaveCount(0);
});

test('a normal start shows no release notes', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  await expect(page.getByTestId('release-notes')).toHaveCount(0);
});
