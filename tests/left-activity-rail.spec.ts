import { test, expect } from '@playwright/test';

/**
 * Slice: left-activity-rail.
 *
 * Drives the always-visible far-left activity rail against the fake backend:
 *  - the rail is visible on load and carries the menu / quick-nav / search icons;
 *  - its quick-nav icon opens the existing QuickNav palette (same overlay flag as
 *    Ctrl+K) and its search icon opens the SearchPanel (same flag as
 *    Ctrl+Shift+F);
 *  - the rail stays visible when the left Sidebar is collapsed;
 *  - a bottom avatar/login slot is reserved but empty on desktop.
 */

test('activity rail: icons open QuickNav / SearchPanel and rail survives sidebar collapse', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();

  const rail = page.getByTestId('activity-rail');
  await expect(rail).toBeVisible();
  await expect(page.getByTestId('rail-menu')).toBeVisible();
  await expect(page.getByTestId('rail-quicknav')).toBeVisible();
  await expect(page.getByTestId('rail-search')).toBeVisible();
  // The bottom avatar/login slot is reserved but empty on desktop.
  await expect(page.getByTestId('rail-user')).toBeEmpty();

  // Quick-nav icon opens the QuickNav palette; Escape closes it.
  await page.getByTestId('rail-quicknav').click();
  const palette = page.getByTestId('quick-nav');
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();

  // Search icon opens the SearchPanel; Escape closes it.
  await page.getByTestId('rail-search').click();
  const panel = page.getByTestId('search-panel');
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  // Keybindings still work: Ctrl+K opens the same palette the icon opened.
  await page.keyboard.press('Control+k');
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();

  // Collapsing the left Sidebar (via the NavBar toggle) hides the Sidebar but the
  // rail — which lives outside it — stays visible.
  await page.getByTestId('sidebar-toggle').click();
  await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('side-bar')).not.toBeVisible();
  await expect(rail).toBeVisible();

  // The rail's icons still work with the Sidebar collapsed.
  await page.getByTestId('rail-search').click();
  await expect(panel).toBeVisible();
});
