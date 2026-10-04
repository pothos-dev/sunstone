import { test, expect, type Page } from './fixtures';

/**
 * The right rail's joined font-size button steps the UI zoom exactly like
 * Ctrl +/-, and the explorer tree is set in the same face and size as the
 * Concept body at every zoom level.
 */

const fontOf = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const s = getComputedStyle(el);
    return { family: s.fontFamily, size: s.fontSize };
  });

test('rail font-size button zooms; explorer matches the Concept body', async ({ page }) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('CodeMirror 6 is the editor core');

  const expectMatching = async (px: string) => {
    const body = await fontOf(page, '[data-testid="editor"] .cm-line');
    const entry = await fontOf(page, '[data-path="concepts/codemirror.md"]');
    expect(body.size).toBe(px);
    expect(entry).toEqual(body);
  };

  await expectMatching('14px');

  // The font-size button sits on the right rail only.
  await expect(page.getByTestId('activity-rail-right').getByTestId('rail-zoom')).toBeVisible();
  await expect(page.getByTestId('activity-rail').getByTestId('rail-zoom')).toHaveCount(0);

  // It spans the full rail width and sits flush on the rail's bottom edge.
  const railBox = (await page.getByTestId('activity-rail-right').boundingBox())!;
  const zoomBox = (await page.getByTestId('rail-zoom').boundingBox())!;
  expect(Math.round(railBox.x + railBox.width - (zoomBox.x + zoomBox.width))).toBe(0);
  expect(Math.round(zoomBox.width)).toBe(Math.round(railBox.width) - 1); // minus the hairline
  expect(Math.round(railBox.y + railBox.height - (zoomBox.y + zoomBox.height))).toBe(0);

  const toggleSize = async () => {
    const box = (await page.getByTestId('rail-toggle-left').boundingBox())!;
    return [box.width, box.height];
  };
  const sizeAt100 = await toggleSize();

  await page.getByTestId('rail-zoom-in').click();
  await expect(page.locator('html')).toHaveCSS('font-size', '17.6px');
  await expectMatching('15.4px');
  // Rail chrome is px-pinned: zoom never resizes its buttons.
  expect(await toggleSize()).toEqual(sizeAt100);

  await page.getByTestId('rail-zoom-out').click();
  await page.getByTestId('rail-zoom-out').click();
  await expect(page.locator('html')).toHaveCSS('font-size', '14.4px');
  await expectMatching('12.6px');

  // Ctrl+0 resets the same zoom the buttons stepped.
  await page.keyboard.press('Control+0');
  await expect(page.locator('html')).toHaveCSS('font-size', '16px');
  await expect(page.getByTestId('rail-zoom-in')).toHaveAttribute('title', /100%/);
});
