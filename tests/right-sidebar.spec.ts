import { test, expect } from '@playwright/test';

/**
 * Slice: right-sidebar-move-backlinks.
 *
 * The right Sidebar mirrors the left one but starts COLLAPSED. It now houses the
 * Backlinks Section (moved out of the left Sidebar). This drives the fake backend
 * (localStorage-backed, so a page RELOAD restores state exactly as the real
 * backend restores from the OS config file) to assert:
 *  - a fresh Bundle opens with the right Sidebar collapsed (Backlinks hidden),
 *  - the nav-bar right-track toggle expands it and Backlinks becomes usable,
 *  - exercising Backlinks still opens sources through navigation, and
 *  - the expanded state persists across a reload.
 */

test('right sidebar starts collapsed, expands to reveal Backlinks, and persists', async ({
  page,
}) => {
  await page.goto('/');

  let tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // Clean slate so the "fresh Bundle" defaults apply deterministically. Clear
  // AFTER the first load and reload once to boot fresh.
  await page.evaluate(() => window.localStorage.setItem('sunstone:bundleState:/fake/bundle', JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'] })));
  await page.reload();
  tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // Fresh-Bundle default: the right Sidebar is COLLAPSED (toggle not pressed).
  // The aside animates its width to 0 and clips its content (which keeps its
  // width and slides out), so we assert the rendered width rather than DOM
  // visibility (the clipped inner is still "visible" to Playwright).
  const rightToggle = page.getByTestId('right-sidebar-edge');
  const rightAside = page.getByTestId('right-side-bar');
  await expect(rightToggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await rightAside.boundingBox())?.width).toBe(0);

  // Expand the right Sidebar via its nav-bar toggle; Backlinks becomes usable.
  await rightToggle.click();
  await expect(rightToggle).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await rightAside.boundingBox())?.width).toBeGreaterThan(0);
  const backlinks = page.getByTestId('backlinks');
  await expect(backlinks).toBeVisible();

  // Open a Concept several others link TO; Backlinks lists the sources and a
  // click opens that source Concept (through navigation history).
  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('CodeMirror 6 is the editor core');

  const entries = backlinks.getByTestId('backlink');
  await expect(entries).toHaveCount(4);
  await backlinks.locator('[data-path="concepts/bundle.md"]').click();
  await expect(editor).toContainText('A Bundle is the root folder');

  await page.screenshot({ path: 'tests/screenshots/right-sidebar.png', fullPage: true });

  // Give the debounced save time to flush, then assert it persisted.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('sunstone:bundleState:/fake/bundle');
        if (!raw) return null;
        return JSON.parse(raw) as { rightSidebarOpen?: boolean };
      }),
    )
    .toMatchObject({ rightSidebarOpen: true });

  // RELOAD: the right Sidebar stays EXPANDED (Backlinks visible).
  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();
  await expect(page.getByTestId('right-sidebar-edge')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('backlinks')).toBeVisible();
});
