import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';

/**
 * Tiles share one Document per Concept. Opening a Concept in a Tile must not
 * re-read it from disk while ANOTHER Tile holds unsaved edits on it — that
 * reload would silently replace the live buffer (and the other Tile's view of
 * it) with the older on-disk text.
 *
 * The deterministic source of "unsaved": a held write (an unparseable
 * frontmatter block holds autosave, ADR 0008), so no timing window is needed.
 */

function persisted(page: Page, path: string): Promise<string> {
  return page.evaluate(
    (p) =>
      (
        window as unknown as { __sunstoneFake: { files: Record<string, string> } }
      ).__sunstoneFake.files[p],
    path,
  );
}

test('opening a Concept another Tile is editing keeps its unsaved edits', async ({ page }) => {
  const path = 'concepts/codemirror.md';
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await tree.locator(`[data-path="${path}"]`).click();
  await page.getByTestId('frontmatter-toggle').click();
  await page.getByTestId('edit-toggle').click();

  // Break the YAML so the write is held, then make a body edit.
  const yaml = page.getByTestId('frontmatter').locator('.cm-content');
  await yaml.click();
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  const body = page.getByTestId('editor').locator('.cm-content');
  await body.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\nUNSAVED_EDIT');
  await expect(page.getByTestId('save-concept')).toBeVisible({ timeout: 5_000 });
  expect(await persisted(page, path)).not.toContain('UNSAVED_EDIT');

  // A second Tile: navigate it away, then back to the same Concept.
  await page.getByTestId('split-right').first().click();
  await expect(page.getByTestId('editor')).toHaveCount(2);
  await tree.locator('[data-path="concepts/editor/live-preview.md"]').click();
  await expect(page.getByTestId('editor').nth(1)).not.toContainText('UNSAVED_EDIT');
  await tree.locator(`[data-path="${path}"]`).click();

  // Both Tiles still show the unsaved edit; nothing reverted to disk.
  await expect(page.getByTestId('editor').nth(1)).toContainText('UNSAVED_EDIT');
  await expect(page.getByTestId('editor').nth(0)).toContainText('UNSAVED_EDIT');
});
