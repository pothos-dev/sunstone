import { test, expect, type Page } from './fixtures';

/**
 * User colour overrides (`config.json` `colors`, state/themeColors.ts).
 *
 * The fake backend reads the overrides from `sunstone:fakeAppearance`, standing
 * in for the user's `config.json`. Verifies, per scheme, that an overridden base
 * colour wins over `app.css`, that a token derived from it follows, and that a
 * key overridden for ONE scheme leaves the other scheme's default alone.
 */

const COLORS = {
  light: { accent: '#2b7fd9', bg: '#f4f7fb' },
  dark: { accent: '#5aa2f0' },
};

async function seed(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate((colors) => {
    window.localStorage.setItem('sunstone:fakeAppearance', JSON.stringify({ colors }));
  }, COLORS);
  await page.reload();
  await expect(page.locator('#sunstone-appearance')).toBeAttached();
}

/** A token as the app root and <html> see it, plus a colour resolved in the app root. */
async function probe(page: Page, token: string, reference: string) {
  return page.evaluate(
    ([token, reference]) => {
      const root = document.querySelector('[data-testid="app-root"]') as HTMLElement;
      const resolve = (value: string) => {
        const el = document.createElement('div');
        el.style.backgroundColor = value;
        root.append(el);
        const color = getComputedStyle(el).backgroundColor;
        el.remove();
        return color;
      };
      return {
        root: getComputedStyle(root).getPropertyValue(token).trim(),
        html: getComputedStyle(document.documentElement).getPropertyValue(token).trim(),
        derived: resolve('var(--accent-soft)'),
        expected: resolve(reference),
      };
    },
    [token, reference],
  );
}

test('light overrides win and derived tokens follow', async ({ page }) => {
  await seed(page);
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-theme', 'light');
  const accent = await probe(page, '--accent', 'color-mix(in srgb, #2b7fd9 16%, transparent)');
  expect(accent.root).toBe('#2b7fd9');
  expect(accent.derived).toBe(accent.expected);
  expect((await probe(page, '--bg', 'red')).html).toBe('#f4f7fb');
});

test('dark overrides win; a light-only override does not leak into dark', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'dark' });
  const page = await context.newPage();
  await seed(page);
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-theme', 'dark');
  const accent = await probe(page, '--accent', 'color-mix(in srgb, #5aa2f0 20%, transparent)');
  expect(accent.root).toBe('#5aa2f0');
  expect(accent.derived).toBe(accent.expected);
  // `bg` is overridden for light only: <html> (which also matches `:root`) and
  // the app root both keep the dark default.
  const bg = await probe(page, '--bg', 'red');
  expect(bg.html).toBe('#1d1511');
  expect(bg.root).toBe('#1d1511');
  await context.close();
});
