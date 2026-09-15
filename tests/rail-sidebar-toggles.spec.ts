import { test, expect } from '@playwright/test';

/**
 * Slice: rail-sidebar-toggles.
 *
 * Both Sidebars are driven from a toggle button pinned to the TOP of their own
 * activity rail — left rail for the left Sidebar, right rail for the right one.
 * The rails are always visible, which is what lets a collapse go all the way to
 * width 0: nothing of the Sidebar (not even its border) has to survive as an
 * affordance.
 *
 * This suite pins the three properties that changed:
 *  - a right rail exists and its toggle drives the right Sidebar;
 *  - collapsing yields a literal 0-width Sidebar AND removes its resize edge;
 *  - the edge is a resize handle only — clicking it no longer toggles.
 */

test('rails carry the Sidebar toggles; collapsing goes to width 0', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();

  const leftRail = page.getByTestId('activity-rail');
  const rightRail = page.getByTestId('activity-rail-right');
  await expect(leftRail).toBeVisible();
  await expect(rightRail).toBeVisible();

  const leftToggle = page.getByTestId('rail-toggle-left');
  const rightToggle = page.getByTestId('rail-toggle-right');
  // Each toggle sits at the very top of its rail, above the other rail buttons.
  await expect(leftRail.locator('button').first()).toHaveAttribute(
    'data-testid',
    'rail-toggle-left',
  );
  await expect(rightRail.locator('button').first()).toHaveAttribute(
    'data-testid',
    'rail-toggle-right',
  );

  // Fresh defaults: left Sidebar expanded, right collapsed. The toggle carries
  // the state (aria-pressed + a label that flips between Collapse / Expand).
  const leftAside = page.getByTestId('side-bar');
  const rightAside = page.getByTestId('right-side-bar');
  await expect(leftToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(leftToggle).toHaveAttribute('aria-label', 'Collapse sidebar');
  await expect(rightToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(rightToggle).toHaveAttribute('aria-label', 'Expand Outline & Backlinks');

  // Collapse the left Sidebar: it goes to a literal 0 width and its resize edge
  // is gone with it — the rail's toggle is the only way back.
  await leftToggle.click();
  await expect(leftToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(leftToggle).toHaveAttribute('aria-label', 'Expand sidebar');
  await expect.poll(async () => (await leftAside.boundingBox())?.width).toBe(0);
  await expect(page.getByTestId('left-sidebar-edge')).toHaveCount(0);
  await expect(leftRail).toBeVisible();

  // And back: the toggle re-expands it and the edge returns.
  await leftToggle.click();
  await expect.poll(async () => (await leftAside.boundingBox())?.width).toBeGreaterThan(0);
  await expect(page.getByTestId('left-sidebar-edge')).toHaveCount(1);

  // The right rail's toggle drives the right Sidebar the same way.
  await expect.poll(async () => (await rightAside.boundingBox())?.width).toBe(0);
  await expect(page.getByTestId('right-sidebar-edge')).toHaveCount(0);
  await rightToggle.click();
  await expect(rightToggle).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await rightAside.boundingBox())?.width).toBeGreaterThan(0);
  await expect(page.getByTestId('right-sidebar-edge')).toHaveCount(1);
});

test('a Sidebar edge resizes but no longer toggles', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();

  const aside = page.getByTestId('side-bar');
  const edge = page.getByTestId('left-sidebar-edge');
  const width = async () => (await aside.boundingBox())?.width;
  const start = (await width())!;

  // A plain click on the border does nothing: it is a resize handle now.
  await edge.click({ force: true });
  await expect(page.getByTestId('rail-toggle-left')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(width).toBe(start);

  // A drag still resizes it, with no click-vs-drag threshold to clear.
  const box = (await edge.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(width).toBeGreaterThan(start + 50);
});
