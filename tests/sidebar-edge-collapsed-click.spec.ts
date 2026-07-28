import { test, expect } from '@playwright/test';

/**
 * Regression: a COLLAPSED Sidebar edge expands on a plain click, and leaves no
 * gesture state behind.
 *
 * The bug (WebKitGTK, i.e. the desktop shell's webview): pressing the collapsed
 * bar started a pointer gesture whose `pointerup` was never delivered, so the
 * toggle never ran — the hover tooltip kept reading "Expand …" — and the window
 * listener from that press survived to fire on the user's NEXT click anywhere,
 * springing the Sidebar open at an unrelated moment.
 *
 * While collapsed there is no visible sidebar to resize, so the edge is now a
 * pure `click` Expand button: no pointer capture, no window listeners, nothing
 * to lose or leave stale. Drag-resize is live once it is open. This suite pins
 * both halves (Chromium cannot reproduce the swallowed `pointerup` itself, but
 * it does prove the collapsed press no longer arms a deferred toggle).
 */
test('a collapsed Sidebar edge expands on click and arms no deferred toggle', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();

  const aside = page.getByTestId('right-side-bar');
  const edge = page.getByTestId('right-sidebar-edge');
  const width = async () => (await aside.boundingBox())?.width;

  // Starts collapsed. A press that drifts a few px (touchpad tap, heavy click)
  // still expands — the collapsed edge does not classify travel as a resize.
  await expect.poll(width).toBe(0);
  const box = (await edge.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 5, y + 5);
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

  // A clean click collapses it …
  await edge.click();
  await expect.poll(width).toBe(0);

  // … and clicking elsewhere afterwards must NOT re-toggle it: the collapsed
  // press leaves no pending gesture behind.
  await page.getByTestId('tree').click({ position: { x: 5, y: 5 } });
  await expect(edge).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(width).toBe(0);
});
