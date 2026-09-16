import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';

/**
 * Slice: markdown-links-navigation.
 *
 * Drives OKF link navigation with browser-style history against the fake
 * backend:
 *  - opens a Concept (`concepts/bundle.md`) containing BOTH a relative link
 *    (`./codemirror.md`) and a bundle-absolute link (`/index.md`),
 *  - clicks the relative link and asserts the target Concept opens in the tile,
 *  - asserts Back returns to the original Concept and Forward re-advances,
 *  - exercises the absolute link and the Ctrl+Alt+Left (history Back) shortcut.
 *
 * atomic-editor's live preview makes link TEXT editable and routes navigation
 * through a trailing "open" icon (a `::after` pseudo-element ~1.25em wide at the
 * link's right edge). So we click the right edge of the rendered link span, not
 * its centre (which would just place the cursor) — mirroring the real UX.
 */
async function clickLink(page: Page, label: string): Promise<void> {
  const link = page
    .getByTestId('editor')
    .locator('.cm-atomic-link', { hasText: label })
    .first();
  const box = await link.boundingBox();
  if (!box) throw new Error(`link not found: ${label}`);
  // Click inside the trailing icon hit-zone at the right edge.
  await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
}

test('OKF link navigation + back/forward history', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // Open the Concept that links to others.
  await tree.locator('[data-path="concepts/bundle.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('A Bundle is the root folder');

  const back = page.getByTestId('nav-back');
  const forward = page.getByTestId('nav-forward');
  // Only one Concept visited so far: nothing to go back/forward to.
  await expect(back).toBeDisabled();
  await expect(forward).toBeDisabled();

  // Click the RELATIVE link (./codemirror.md) rendered in the live preview.
  await clickLink(page, 'CodeMirror');
  await expect(editor).toContainText('CodeMirror 6 is the editor core');
  await expect(
    page.locator('[data-path="concepts/codemirror.md"]'),
  ).toHaveClass(/selected/);

  // Back returns to the original Concept; Forward re-advances.
  await expect(back).toBeEnabled();
  await back.click();
  await expect(editor).toContainText('A Bundle is the root folder');
  await expect(forward).toBeEnabled();

  await forward.click();
  await expect(editor).toContainText('CodeMirror 6 is the editor core');

  // Back again, then exercise the BUNDLE-ABSOLUTE link (/index.md). Navigating
  // after Back truncates the forward entry (standard browser semantics).
  await back.click();
  await expect(editor).toContainText('A Bundle is the root folder');
  await clickLink(page, 'Knowledge Base');
  await expect(editor).toContainText('reserved');
  // index.md is a reserved file: it's surfaced as a root affordance (not an
  // ordinary leaf), which reflects selection when it's the open Concept.
  await expect(page.locator('[data-reserved-path="index.md"]')).toHaveClass(/selected/);
  // Forward history was truncated by this new navigation.
  await expect(forward).toBeDisabled();

  // Keyboard shortcut: Ctrl+Alt+Left goes Back to the previous Concept
  // (history moved off plain Alt+Left, now Region movement — region-focus-backbone).
  await page.keyboard.press('Control+Alt+ArrowLeft');
  await expect(editor).toContainText('A Bundle is the root folder');

  await page.screenshot({
    path: 'tests/screenshots/links-navigation.png',
    fullPage: true,
  });
});
