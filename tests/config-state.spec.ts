import { test, expect } from './fixtures';

/**
 * Slice: config-theme-state-store.
 *
 * Verifies the per-Bundle session persistence + OS-driven theming against the
 * fake backend (localStorage-backed, so a page RELOAD restores state exactly as
 * the real backend restores from the OS config file):
 *  - opens a Concept and expands a deep folder, reloads, asserts both restored,
 *  - asserts the app root carries a `data-theme` reflecting the color scheme,
 *  - drives `prefers-color-scheme: dark` and asserts `data-theme="dark"`.
 */

test('session state persists across reload; theme follows OS', async ({ page }) => {
  await page.goto('/');

  let tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // Start from a clean slate so the "fresh Bundle" defaults apply
  // deterministically. Clear AFTER the first load (not via addInitScript, which
  // would re-clear on every navigation, including the reload under test) and
  // reload once to boot fresh.
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  const appRoot = page.getByTestId('app-root');
  // The app root must carry a data-theme reflecting the color scheme. The
  // default emulated scheme is light.
  await expect(appRoot).toHaveAttribute('data-theme', /^(light|dark)$/);

  // `concepts/` holds an `index.md`, so it starts COLLAPSED by default (its
  // index page stands in for browsing its contents); the deep Concept is
  // therefore hidden on a fresh Bundle. EXPAND `concepts/` to produce a
  // non-default folder state — restoring it after reload proves expand/collapse
  // changes persist, not just defaults.
  const livePreview = tree.locator('[data-path="concepts/editor/live-preview.md"]');
  await expect(livePreview).toBeHidden();

  // Expand `concepts/` via its disclosure twisty (its NAME-click would open the
  // index page instead of toggling), then expand its child `concepts/editor`. On
  // a fresh Bundle every folder starts collapsed, so both ancestors must be
  // opened for the deep file to surface.
  await tree.locator('[data-row-path="concepts"] button.twisty-toggle').click();
  await tree.locator('[data-row-path="concepts/editor"] button.twisty-toggle').click();
  await expect(livePreview).toBeVisible();
  await livePreview.click();

  const editorPane = page.getByTestId('editor');
  await expect(editorPane).toContainText('Obsidian-style hybrid editing');

  // Give the debounced save time to flush to localStorage: the open Concept is
  // the deep one, and the expanded set now contains the manually-opened
  // `concepts` on top of the seeded `concepts/editor`.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('sunstone:bundleState:/fake/bundle');
        if (!raw) return null;
        return JSON.parse(raw) as { lastOpenConcept: string | null; expandedFolders: string[] };
      }),
    )
    .toMatchObject({
      lastOpenConcept: 'concepts/editor/live-preview.md',
      expandedFolders: expect.arrayContaining(['concepts', 'concepts/editor']),
    });

  // RELOAD: the last-open Concept reopens; `concepts` stays EXPANDED (its
  // deep child visible again) rather than snapping back to the collapsed default.
  await page.reload();

  await expect(page.getByTestId('tree')).toBeVisible();
  await expect(
    page.getByTestId('tree').locator('[data-path="concepts/editor/live-preview.md"]'),
  ).toBeVisible();
  // The last-open Concept is reopened (open state is independent of tree visibility).
  await expect(page.getByTestId('editor')).toContainText('Obsidian-style hybrid editing');

  await page.screenshot({ path: 'tests/screenshots/config-state.png', fullPage: true });
});

test('dark color scheme yields data-theme="dark"', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'dark' });
  const page = await context.newPage();

  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-theme', 'dark');

  await context.close();
});
