import { test, expect } from './fixtures';

/**
 * A rename/move the backend REJECTS must roll the open Concept back to where it
 * was. The open path follows optimistically before the backend call (so the
 * backend's `removed` event doesn't clear the editor); on failure that follow
 * is undone by mapping the destination back onto the SOURCE — for a folder
 * rename, the open Concept inside the folder must land back at its old path,
 * not at `<old open path>/<basename>`.
 */

async function openRowMenu(page: import('@playwright/test').Page, path: string) {
  await page.getByTestId('tree').locator(`[data-row-path="${path}"]`).click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
}

test('a rejected folder rename rolls the open Concept back to its old path', async ({ page }) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  const open = 'concepts/editor/live-preview.md';

  await tree.locator(`[data-path="${open}"]`).click();
  await expect(tree.locator(`[data-path="${open}"]`)).toHaveClass(/selected/);

  // Rename the folder onto an existing sibling: the backend refuses it.
  await openRowMenu(page, 'concepts/editor');
  await page.getByTestId('context-menu').locator('[data-action="rename"]').click();
  await page.getByTestId('dialog-input').fill('codemirror.md');
  await page.getByTestId('dialog-confirm').click();

  await expect(page.getByTestId('tree-error')).toContainText('already exists');
  // Nothing moved, and the open Concept is still the one at its old path.
  await expect(tree.locator(`[data-path="${open}"]`)).toHaveClass(/selected/);
});

test('a rejected file rename leaves every Tile on its own Concept', async ({ page }) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  const renamed = 'concepts/codemirror.md';

  // Tile 1 shows the Concept about to be renamed; Tile 2 (active) another one.
  await tree.locator(`[data-path="${renamed}"]`).click();
  await page.getByTestId('split-right').first().click();
  await expect(page.getByTestId('editor')).toHaveCount(2);
  await tree.locator('[data-path="concepts/editor/live-preview.md"]').click();
  await expect(page.getByTestId('editor').nth(0)).toContainText('CodeMirror 6 is the editor core');

  // Rename it onto an existing Concept: the backend refuses it.
  await openRowMenu(page, renamed);
  await page.getByTestId('context-menu').locator('[data-action="rename"]').click();
  await page.getByTestId('dialog-input').fill('bundle');
  await page.getByTestId('dialog-confirm').click();

  await expect(page.getByTestId('tree-error')).toContainText('already exists');
  // Tile 1 still shows its own Concept — not the active Tile's, not the target's.
  await expect(page.getByTestId('editor').nth(0)).toContainText('CodeMirror 6 is the editor core');
  await expect(page.getByTestId('editor').nth(1)).not.toContainText('CodeMirror 6 is the editor core');
});
