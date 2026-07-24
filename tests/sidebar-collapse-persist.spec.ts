import { test, expect } from '@playwright/test';

/**
 * Slice: persist-sidebar-collapse-state.
 *
 * The left Sidebar's whole-sidebar collapse and each Section's expanded flag now
 * live in the persisted per-Bundle session store (instead of ephemeral local
 * `$state`), so they survive a reload. This drives the fake backend
 * (localStorage-backed, so a page RELOAD restores state exactly as the real
 * backend restores from the OS config file):
 *  - a fresh Bundle opens with the left Sidebar and the Explorer expanded, but
 *    the Tags Section COLLAPSED (its per-field default),
 *  - collapsing the sidebar + expanding the Tags section persists, and both are
 *    restored after a reload.
 */

test('sidebar + section collapse state persists across reload', async ({ page }) => {
  await page.goto('/');

  let tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // Clean slate so the "fresh Bundle" defaults apply deterministically. Clear
  // AFTER the first load (not via addInitScript, which would re-clear on the
  // reload under test) and reload once to boot fresh.
  await page.evaluate(() => window.localStorage.setItem('sunstone:bundleState:/fake/bundle', JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'] })));
  await page.reload();
  tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // Fresh-Bundle defaults: the left Sidebar is expanded (the toggle is pressed)
  // and the Explorer is expanded, but the Tags Section starts COLLAPSED (its
  // per-field default). Backlinks now lives in the right Sidebar
  // (right-sidebar-move-backlinks), so it is no longer here.
  const sidebarToggle = page.getByTestId('left-sidebar-edge');
  await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'true');

  const explorerSection = page.getByTestId('explorer-section');
  const tagsSection = page.getByTestId('tags-section');
  // Each SidebarSection's header toggle reflects expanded state via aria-expanded.
  const explorerToggle = explorerSection.locator('[aria-expanded]').first();
  const tagsToggle = tagsSection.locator('[aria-expanded]').first();
  await expect(explorerToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(tagsToggle).toHaveAttribute('aria-expanded', 'false');

  // Expand the Tags section, then collapse the whole left Sidebar. This is a
  // non-default state, so restoring it after reload proves the toggles persist.
  await tagsToggle.click();
  await expect(tagsToggle).toHaveAttribute('aria-expanded', 'true');
  await sidebarToggle.click();
  await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'false');

  // Give the debounced save time to flush to localStorage.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('sunstone:bundleState:/fake/bundle');
        if (!raw) return null;
        return JSON.parse(raw) as {
          leftSidebarOpen?: boolean;
          tagsOpen?: boolean;
          explorerOpen?: boolean;
          backlinksOpen?: boolean;
        };
      }),
    )
    .toMatchObject({
      leftSidebarOpen: false,
      tagsOpen: true,
      explorerOpen: true,
    });

  // RELOAD: the left Sidebar stays COLLAPSED and the Tags section stays
  // EXPANDED, while Explorer stays expanded.
  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();

  await expect(page.getByTestId('left-sidebar-edge')).toHaveAttribute('aria-pressed', 'false');
  await expect(
    page.getByTestId('tags-section').locator('[aria-expanded]').first(),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByTestId('explorer-section').locator('[aria-expanded]').first(),
  ).toHaveAttribute('aria-expanded', 'true');

  await page.screenshot({ path: 'tests/screenshots/sidebar-collapse-persist.png', fullPage: true });
});

/**
 * Slice: multi-concept-tiling.
 *
 * The GLOBAL Properties show/hide flag (NavBar toggle) is persisted in the
 * session store, so the choice survives a reload — it defaults to HIDDEN.
 */
test('global Properties show/hide flag persists across reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();

  // Reset to a deterministic state: concepts/ + concepts/editor/ expanded (concepts/
  // now defaults COLLAPSED as it holds an index.md), everything else at defaults.
  await page.evaluate(() => window.localStorage.setItem('sunstone:bundleState:/fake/bundle', JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'] })));
  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();

  // Open a Concept. Properties is HIDDEN by default: no chrome.
  await page.locator('[data-path="concepts/bundle.md"]').click();
  await expect(page.getByTestId('properties')).toHaveCount(0);

  // Turn it ON via the NavBar toggle — a non-default state whose restoration
  // proves persistence.
  const toggle = page.getByTestId('properties-toggle');
  await toggle.click();
  await expect(page.getByTestId('properties')).toBeVisible();

  // The debounced save flushes `propertiesShown: true` to localStorage.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('sunstone:bundleState:/fake/bundle');
        if (!raw) return null;
        return (JSON.parse(raw) as { propertiesShown?: boolean }).propertiesShown ?? null;
      }),
    )
    .toBe(true);

  // RELOAD: the last Concept reopens and the Properties panel stays SHOWN.
  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();
  await expect(page.getByTestId('properties')).toBeVisible();
});

/**
 * Slice: edge-sidebars-delete-navbar.
 *
 * Each sidebar's border is a drag handle that resizes it, and the chosen width
 * is persisted per-Bundle. Dragging the left edge right widens the left Sidebar;
 * the new width survives a reload.
 */
test('sidebar width: dragging the edge resizes and the width persists across reload', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();

  // Clean slate so the default 280px width applies deterministically.
  await page.evaluate(() =>
    window.localStorage.setItem(
      'sunstone:bundleState:/fake/bundle',
      JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'] }),
    ),
  );
  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();

  // The aside's rendered width is the persisted content width plus its 1px
  // border, so assert with a small tolerance.
  const aside = page.getByTestId('side-bar');
  const startWidth = (await aside.boundingBox())?.width ?? 0;
  expect(Math.abs(startWidth - 280)).toBeLessThan(3);

  // Drag the left edge 80px to the right → the left Sidebar widens by ~80px.
  const edge = page.getByTestId('left-sidebar-edge');
  const box = (await edge.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect
    .poll(async () => (await aside.boundingBox())?.width)
    .toBeGreaterThan(startWidth + 70);

  // The debounced save flushes the new width (280 + 80 = 360) to localStorage.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('sunstone:bundleState:/fake/bundle');
        if (!raw) return null;
        return (JSON.parse(raw) as { leftSidebarWidth?: number }).leftSidebarWidth ?? null;
      }),
    )
    .toBe(360);

  // RELOAD: the widened Sidebar comes back at its persisted width.
  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();
  await expect
    .poll(async () => (await page.getByTestId('side-bar').boundingBox())?.width)
    .toBeGreaterThan(startWidth + 70);
});
