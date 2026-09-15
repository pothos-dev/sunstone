import { test, expect, type Page } from '@playwright/test';

/**
 * Regression: the rail's Sidebar toggle must collapse the Sidebar even when it
 * is on screen because of a transient auto-reveal (Alt+dir), not a persisted
 * open.
 *
 * The bug: the toggle was fed `rightSidebarOpen` while the aside was sized by
 * `rightSidebarVisible` (`open || revealed`). After an Alt+Right peek,
 * `revealed` stayed latched (the focus backbone preserves the flag for the
 * Region you just entered), so `visible` was pinned to `true` — clicking the
 * toggle flipped `open` and merely swapped the icon while the Sidebar itself
 * never moved. The left Sidebar was unaffected only because nothing had
 * revealed it.
 */

async function activeRegion(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector('.region-active[data-region]');
    return el ? el.getAttribute('data-region') : null;
  });
}

async function openConcept(page: Page) {
  await page.goto('/');
  let tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.evaluate(() =>
    window.localStorage.setItem(
      'sunstone:bundleState:/fake/bundle',
      JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'] }),
    ),
  );
  await page.reload();
  tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('CodeMirror 6 is the editor core');
  await page.getByTestId('edit-toggle').click();
  await editor.locator('.cm-content').click();
  await expect.poll(() => activeRegion(page)).toBe('editor');
}

test('right rail toggle collapses a transiently-revealed Sidebar', async ({ page }) => {
  await openConcept(page);

  const aside = page.getByTestId('right-side-bar');
  const toggle = page.getByTestId('rail-toggle-right');

  // Fresh default: the right Sidebar is collapsed.
  await expect(aside).toHaveClass(/collapsed/);

  // Alt+Right transiently reveals it and lands focus in Backlinks.
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => activeRegion(page)).toBe('backlinks');
  await expect(aside).not.toHaveClass(/collapsed/);
  expect((await aside.boundingBox())?.width).toBeGreaterThan(0);

  // THE REGRESSION: one click on the rail toggle must actually collapse it, not
  // just swap the icon while the reveal keeps the Sidebar on screen.
  await toggle.click();
  await expect(aside).toHaveClass(/collapsed/);
  await expect.poll(async () => (await aside.boundingBox())?.width).toBe(0);

  // And it expands again from the rail toggle.
  await toggle.click();
  await expect(aside).not.toHaveClass(/collapsed/);
  await expect.poll(async () => (await aside.boundingBox())?.width).toBeGreaterThan(0);
});
