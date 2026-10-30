import { test, expect, type Page } from './fixtures';

/**
 * The settings page (components/settings/, state/settings.svelte.ts).
 *
 * The fake backend's `config.json` is the `sunstone:fakeAppearance`
 * localStorage entry. Each test seeds one with keys the page never shows, and
 * checks that a change rewrites only its own key, previews at once, and
 * survives a reload.
 */

const KEY = 'sunstone:fakeAppearance';
const HAND_WRITTEN = {
  $comment: 'mine',
  fonts: { code: { family: 'JetBrains Mono', files: ['JBM.woff2'] } },
};

async function seed(page: Page, config: object = HAND_WRITTEN): Promise<void> {
  await page.goto('/');
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [KEY, JSON.stringify(config)]);
  await page.reload();
  await expect(page.getByTestId('app-root')).toBeVisible();
}

const stored = (page: Page) =>
  page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? 'null'), KEY) as Promise<Record<string, unknown>>;

async function openSettings(page: Page): Promise<void> {
  await page.getByTestId('rail-settings').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
}

test('opens from the rail and with Ctrl+, and closes with Escape', async ({ page }) => {
  await seed(page);
  await openSettings(page);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-dialog')).toBeHidden();

  await page.keyboard.press('Control+,');
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  await page.keyboard.press('Control+,');
  await expect(page.getByTestId('settings-dialog')).toBeHidden();
});

test('the theme mode applies at once and writes only `theme`', async ({ page }) => {
  await seed(page);
  await openSettings(page);
  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await expect.poll(() => stored(page)).toEqual({ ...HAND_WRITTEN, theme: 'dark' });

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // System is the default: choosing it removes the key again.
  await openSettings(page);
  await page.getByRole('radio', { name: 'System' }).click();
  await expect.poll(() => stored(page)).toEqual(HAND_WRITTEN);
});

test('a colour theme is stored by id; Escape steps back before it closes', async ({ page }) => {
  await seed(page);
  await openSettings(page);
  await page.getByTestId('settings-browse-themes').click();
  await page.getByTestId('settings-preset-nord').click();

  // A <style> has no rendered text, so read its source.
  await expect
    .poll(() => page.locator('#sunstone-appearance').evaluate((el) => el.textContent ?? ''))
    .toContain('--bg: #eceff4;');
  await expect.poll(() => stored(page)).toEqual({ ...HAND_WRITTEN, colorTheme: 'nord' });

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-browse-themes')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-dialog')).toBeHidden();
});

test('a font change keeps the hand-written font files', async ({ page }) => {
  await seed(page);
  await openSettings(page);
  await page.getByTestId('settings-nav-fonts').click();
  await page.getByTestId('settings-font-code-family').fill('Fira Code');
  await page.getByTestId('settings-font-code-family').press('Enter');

  await expect
    .poll(() => stored(page))
    .toEqual({ $comment: 'mine', fonts: { code: { family: 'Fira Code', files: ['JBM.woff2'] } } });
});

test('a layout default is written, and switching it back removes the emptied object', async ({ page }) => {
  await seed(page);
  await openSettings(page);
  await page.getByTestId('settings-nav-layout').click();
  await page.getByTestId('settings-default-tags').check();
  await expect.poll(() => stored(page)).toEqual({ ...HAND_WRITTEN, defaults: { tags: true } });

  await page.getByTestId('settings-default-tags').uncheck();
  await expect.poll(() => stored(page)).toEqual(HAND_WRITTEN);
});

test('a rebound shortcut moves the command, and recording does not trigger it', async ({ page }) => {
  await seed(page);
  await openSettings(page);
  await page.getByTestId('settings-nav-keyboard').click();
  await page.getByRole('button', { name: 'Change the shortcut for Quick open' }).click();

  // Ctrl+K while recording is recorded, not run.
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('quick-nav')).toBeHidden();
  await page.getByRole('button', { name: 'Change the shortcut for Quick open' }).click();
  await page.keyboard.press('Control+j');
  await expect.poll(() => stored(page)).toEqual({ ...HAND_WRITTEN, keybindings: { quickNav: 'Mod-j' } });

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-dialog')).toBeHidden();

  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('quick-nav')).toBeHidden();
  await page.keyboard.press('Control+j');
  await expect(page.getByTestId('quick-nav')).toBeVisible();
});

test('Backspace unbinds a shortcut, stored as null', async ({ page }) => {
  await seed(page);
  await openSettings(page);
  await page.getByTestId('settings-nav-keyboard').click();
  await page.getByRole('button', { name: 'Change the shortcut for Bold' }).click();
  await page.keyboard.press('Backspace');
  await expect(page.getByTestId('settings-key-bold')).toContainText('Not set');
  await expect.poll(() => stored(page)).toEqual({ ...HAND_WRITTEN, keybindings: { bold: null } });
});

test('a corrupt config.json is never overwritten', async ({ page }) => {
  await page.goto('/');
  await page.evaluate((key) => window.localStorage.setItem(key, '{ not json'), KEY);
  await page.reload();
  await openSettings(page);
  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.getByTestId('settings-error')).toBeVisible();
  expect(await page.evaluate((key) => window.localStorage.getItem(key), KEY)).toBe('{ not json');
});
