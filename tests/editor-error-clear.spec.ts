import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';

/**
 * Regression: a stale open/read error must clear when an external change
 * successfully reloads the open Concept.
 *
 * Navigating to a BROKEN link opens a missing Concept and surfaces a read
 * error (`.status.error`). If another tool then CREATES that file, the fake
 * watcher fires and `editor.onExternalChange` reloads it — the reload succeeds,
 * so the editor now shows real content and the error banner must disappear.
 * Previously the success path never cleared `error`, leaving a stale banner.
 */

/** Click the trailing "open" icon of a rendered live-preview link (see links-navigation). */
async function clickLink(page: Page, label: string): Promise<void> {
  const link = page
    .getByTestId('editor')
    .locator('.cm-atomic-link', { hasText: label })
    .first();
  const box = await link.boundingBox();
  if (!box) throw new Error(`link not found: ${label}`);
  await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
}

test('external reload clears a stale open error', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // Open a Concept that links to a non-existent target.
  await tree.locator('[data-path="concepts/links-demo.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('Working links resolve to real Concepts');

  // Follow the BROKEN link (./ghost.md → concepts/ghost.md): the open Concept is
  // now missing, so a read error is surfaced.
  await clickLink(page, 'Ghost Concept');
  const errorBanner = page.locator('.status.error');
  await expect(errorBanner).toBeVisible();

  // Another tool CREATES the missing file. The fake watcher fires a `modified`
  // change for the open path; the reload succeeds.
  await page.evaluate(() => {
    (
      window as unknown as {
        __sunstoneFake: {
          simulateExternalChange: (kind: string, path: string, content?: string) => void;
        };
      }
    ).__sunstoneFake.simulateExternalChange(
      'modified',
      'concepts/ghost.md',
      `---\ntype: concept\ntitle: Ghost\n---\n\n# Ghost Now Exists\n`,
    );
  });

  // The reloaded content shows AND the stale error banner is gone.
  await expect(editor).toContainText('Ghost Now Exists');
  await expect(errorBanner).toHaveCount(0);
});
