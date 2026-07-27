import { test, expect } from './fixtures';
import { mountShell } from './web-shell';

/**
 * The WEB URL contract for the signed-in (App shell) surface.
 *
 * On the anon read surface the URL is the navigation model already (`goto` per
 * Concept). The App shell drives navigation in-process, so it projects the active
 * Tile's Concept onto the URL with shallow `pushState` (`web/urlSync.ts`): the
 * address bar always names the Concept on screen, a reload lands back on it, and
 * the browser's Back/Forward walk the visited Concepts WITHOUT re-running the
 * route `load` (no SSR round-trip, no re-mounted island).
 *
 * That contract is only well-defined with ONE Tile, so this spec also pins the
 * other half of the decision: the web build ships no split affordance, and a
 * persisted desktop-style layout can never override the Concept the URL asked for.
 */

/** The active Tile's Concept, as the URL sees it. */
const path = (page: import('@playwright/test').Page) => new URL(page.url()).pathname;

test('the URL follows the Concept the shell opens, and survives a reload', async ({ page }) => {
  await mountShell(page, '/good');
  expect(path(page)).toBe('/good');

  // Open another Concept from the interactive tree → the URL follows it.
  await page.getByTestId('tree').locator('[data-path="critic.md"]').click();
  await expect(page).toHaveURL(/\/critic$/);

  // A reload lands on THAT Concept (the URL is the source of truth — no
  // localStorage layout, no SSR/CSR disagreement).
  await page.reload();
  await expect(page.getByTestId('web-app-shell')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="editor"] .cm-content').first()).toContainText(
    'Critic',
  );
  expect(path(page)).toBe('/critic');
});

test('browser Back / Forward walk the visited Concepts without an SSR reload', async ({ page }) => {
  await mountShell(page, '/good');
  const shell = page.getByTestId('web-app-shell');
  const content = page.locator('[data-testid="editor"] .cm-content').first();

  await page.getByTestId('tree').locator('[data-path="critic.md"]').click();
  await expect(page).toHaveURL(/\/critic$/);
  await expect(content).toContainText('Critic');

  await page.goBack();
  await expect(page).toHaveURL(/\/good$/);
  await expect(content).toContainText('Good Concept');
  // Shallow history: the island was never torn down and re-mounted, so the shell
  // stays put (a `load` re-run would have flashed the loading placeholder).
  await expect(shell).toBeVisible();
  await expect(page.getByTestId('web-app-loading')).toHaveCount(0);

  await page.goForward();
  await expect(page).toHaveURL(/\/critic$/);
  await expect(content).toContainText('Critic');
  await expect(shell).toBeVisible();
});

test('the web build offers no split affordance (one Tile keeps the URL well-defined)', async ({
  page,
}) => {
  await mountShell(page, '/good');
  await expect(page.getByTestId('split-right')).toHaveCount(0);
  await expect(page.getByTestId('split-down')).toHaveCount(0);
});

test('a signed-in visitor is never served the anon read surface first', async ({ page }) => {
  // SSR knows the session, so the first paint is the shell's own loading state —
  // not a read surface (with its own theme + Concept) that is thrown away on
  // hydration. Asserted against the raw SSR HTML, before any JS runs.
  await mountShell(page, '/good');
  const html = await page.request.get('/good').then((r) => r.text());
  expect(html).toContain('web-app-loading');
  expect(html).not.toContain('data-testid="web-viewer"');
});
