import { test, expect } from '@playwright/test';

/**
 * Regression: a COLLAPSED Sidebar edge must expand on release even when the
 * pointer drifted a few px during the press.
 *
 * The bug: the edge classified any gesture past a 4px travel threshold as a
 * resize drag — including while collapsed, where there is no visible sidebar to
 * resize. A touchpad tap or a heavy mouse click that drifted 4px silently
 * resized a 0-width aside instead of toggling, so the Sidebar could not be
 * brought back at all (the hover tooltip still read "Expand …", which is what
 * made it look like the click was being swallowed). While collapsed the edge is
 * an Expand button only; drag-resize is live once it is open.
 */
test('a collapsed Sidebar edge expands even when the press drifts', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();

  const aside = page.getByTestId('right-side-bar');
  const edge = page.getByTestId('right-sidebar-edge');
  const width = async () => (await aside.boundingBox())?.width;

  // Starts collapsed. Press on the edge, drift well past the drag threshold,
  // release → expanded.
  await expect.poll(width).toBe(0);
  const box = (await edge.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 9, y + 6);
  await page.mouse.up();
  await expect(edge).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(width).toBeGreaterThan(0);

  // Open again: a drifting press now IS a resize (and must not collapse it).
  const opened = (await width())!;
  const box2 = (await edge.boundingBox())!;
  const x2 = box2.x + box2.width / 2;
  const y2 = box2.y + box2.height / 2;
  await page.mouse.move(x2, y2);
  await page.mouse.down();
  await page.mouse.move(x2 - 40, y2);
  await page.mouse.up();
  await expect(edge).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(width).toBeGreaterThan(opened);

  // And a clean click still collapses it.
  await edge.click();
  await expect.poll(width).toBe(0);
});
