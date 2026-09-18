import { test, expect } from './fixtures';

/**
 * Slice: attachment-files (af-1, ADR-0010) — the widget-reuse guarantee.
 *
 * The Embed field rebuilds its decoration set on every doc change AND every
 * selection change, so the widget for an untouched image is reconstructed
 * constantly. `WidgetType.eq()`, keyed on `(render, placement, width, height,
 * alt, src)`, is what stops that from costing anything: an unrelated edit
 * produces an EQUAL widget, CM6 reuses the existing element, and the browser
 * never re-decodes the image.
 *
 * Observed the way `mermaid-render-caching.spec.ts` observes its render id: we
 * stamp the live `<img>`, edit elsewhere, and assert the stamp survived. A
 * re-decode means CM6 built a fresh `<img>` (`toDOM` ran again) and the stamp is
 * gone with it.
 *
 * The edit is made on the paragraph DIRECTLY ABOVE the Embed, deliberately: far
 * enough away that `eq()` must hold, close enough that the widget stays mounted,
 * so a virtualizer remount cannot be mistaken for a re-render.
 *
 * (The pure key logic is unit-tested in `src/lib/editor/embedPlan.test.ts`; this
 * is the in-browser DOM-reuse observation.)
 */
test('embed: editing text outside an image does not re-decode it', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await tree.locator('[data-path="concepts/embeds-demo.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('Embeds Demo');

  // Editing mode: reading is the default and is read-only.
  await page.getByTestId('edit-toggle').click();

  const img = editor.locator('.cm-embed .embed-image').first();
  await expect(img).toBeVisible({ timeout: 15000 });
  await expect
    .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth), {
      timeout: 15000,
    })
    .toBeGreaterThan(0);

  await img.evaluate((el) => {
    el.dataset.reuseProbe = 'first';
  });

  const paragraph = editor
    .locator('.cm-line', { hasText: 'renders as a block widget below it' })
    .first();
  await paragraph.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Edited prose.');

  // Give an (unwanted) rebuild a chance to swap the element before asserting.
  await page.waitForTimeout(500);
  await expect(editor.locator('.cm-embed .embed-image').first()).toHaveAttribute(
    'data-reuse-probe',
    'first',
  );
});
