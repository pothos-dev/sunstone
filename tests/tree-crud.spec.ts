import { test, expect } from './fixtures';

/**
 * Slice: tree-crud.
 *
 * Drives create / rename / move / delete for Concepts and folders from the
 * document tree, against the fake backend:
 *  - create a Concept (appears in the tree, opens in the editor),
 *  - rename it (tree updates; the open editor FOLLOWS to the new path),
 *  - create a folder, move a Concept into it (tree reflects the move),
 *  - delete a Concept (with the confirm dialog) and assert it's gone.
 *
 * The fake backend notifies its file-changed subscribers on every structural
 * op (unlike autosave writes), so the tree + index refresh exactly as the real
 * notify watcher drives them.
 */

/** Open the context menu for a tree node by right-clicking its row. */
async function openRowMenu(page: import('@playwright/test').Page, path: string) {
  const tree = page.getByTestId('tree');
  await tree.locator(`[data-row-path="${path}"]`).click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
}

test('tree CRUD: create, rename, move, delete Concepts and folders', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // --- Create a Concept under concepts/ ---
  await openRowMenu(page, 'concepts');
  await page.getByTestId('context-menu').locator('[data-action="newConcept"]').click();
  await page.getByTestId('dialog-input').fill('fresh-note');
  await page.getByTestId('dialog-confirm').click();

  // It appears in the tree and opens in the editor.
  const created = 'concepts/fresh-note.md';
  await expect(tree.locator(`[data-path="${created}"]`)).toBeVisible();
  await expect(tree.locator(`[data-path="${created}"]`)).toHaveClass(/selected/);

  // --- Rename it; the open editor must FOLLOW to the new path ---
  await openRowMenu(page, created);
  await page.getByTestId('context-menu').locator('[data-action="rename"]').click();
  await page.getByTestId('dialog-input').fill('renamed-note.md');
  await page.getByTestId('dialog-confirm').click();

  const renamed = 'concepts/renamed-note.md';
  await expect(tree.locator(`[data-path="${created}"]`)).toHaveCount(0);
  await expect(tree.locator(`[data-path="${renamed}"]`)).toBeVisible();
  // Editor follows: the renamed Concept is still the selected/open one.
  await expect(tree.locator(`[data-path="${renamed}"]`)).toHaveClass(/selected/);

  // --- Create a folder at the Bundle root ---
  await openRowMenu(page, 'concepts');
  await page.getByTestId('context-menu').locator('[data-action="newFolder"]').click();
  await page.getByTestId('dialog-input').fill('archive');
  await page.getByTestId('dialog-confirm').click();
  // The ⋯ button is hidden until row hover, so assert the node EXISTS (count).
  await expect(tree.locator(`[data-row-path="concepts/archive"]`)).toHaveCount(1);

  // --- Move the renamed Concept into the new folder ---
  await openRowMenu(page, renamed);
  await page.getByTestId('context-menu').locator('[data-action="move"]').click();
  await page
    .getByTestId('dialog-move-target')
    .selectOption('concepts/archive');
  await page.getByTestId('dialog-confirm').click();

  const moved = 'concepts/archive/renamed-note.md';
  await expect(tree.locator(`[data-path="${renamed}"]`)).toHaveCount(0);
  await expect(tree.locator(`[data-path="${moved}"]`)).toBeVisible();
  // Open Concept followed the move.
  await expect(tree.locator(`[data-path="${moved}"]`)).toHaveClass(/selected/);

  await page.screenshot({ path: 'tests/screenshots/tree-crud.png', fullPage: true });

  // --- Renaming an EXPANDED folder keeps it expanded (session follows the rename) ---
  // `concepts/editor` is expanded via the storageState seed, so its child is
  // visible. Its expanded state lives in the session's `expandedFolders`, keyed
  // by path — a rename must remap that key or the renamed folder would collapse.
  const deepChild = tree.locator('[data-path="concepts/editor/live-preview.md"]');
  await expect(deepChild).toBeVisible();
  await openRowMenu(page, 'concepts/editor');
  await page.getByTestId('context-menu').locator('[data-action="rename"]').click();
  await page.getByTestId('dialog-input').fill('writing');
  await page.getByTestId('dialog-confirm').click();
  // The renamed folder stays EXPANDED: its child is visible at the new path.
  await expect(tree.locator('[data-path="concepts/editor/live-preview.md"]')).toHaveCount(0);
  await expect(tree.locator('[data-path="concepts/writing/live-preview.md"]')).toBeVisible();

  // --- Delete a Concept (with confirm) and assert it's gone ---
  await openRowMenu(page, 'concepts/codemirror.md');
  await page.getByTestId('context-menu').locator('[data-action="delete"]').click();
  // The confirm dialog must appear before anything is deleted.
  await expect(page.getByTestId('tree-dialog')).toContainText('Delete');
  await expect(tree.locator('[data-path="concepts/codemirror.md"]')).toBeVisible();
  await page.getByTestId('dialog-confirm').click();
  await expect(tree.locator('[data-path="concepts/codemirror.md"]')).toHaveCount(0);

  // --- Delete a folder recursively (the moved Concept inside goes too) ---
  await openRowMenu(page, 'concepts/archive');
  await page.getByTestId('context-menu').locator('[data-action="delete"]').click();
  await page.getByTestId('dialog-confirm').click();
  await expect(tree.locator(`[data-row-path="concepts/archive"]`)).toHaveCount(0);
  await expect(tree.locator(`[data-path="${moved}"]`)).toHaveCount(0);
  // Deleting the open Concept (inside the folder) clears the editor gracefully.
  await expect(page.getByTestId('placeholder')).toBeVisible();
});
