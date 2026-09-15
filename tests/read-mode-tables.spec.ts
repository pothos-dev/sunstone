import { test, expect } from './fixtures';

/**
 * Reading mode is read-only — including inside table widgets. atomic-editor
 * builds each cell as a raw `contenteditable` div that commits through
 * `view.dispatch`, which `EditorState.readOnly` does not intercept, so the
 * cells were still typeable in read mode (`readOnlyTables` now locks them).
 */
test('read mode: table cells are not editable', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await tree.locator('[data-path="concepts/editor/live-preview.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('Obsidian-style hybrid editing');
  await expect(page.getByTestId('edit-toggle')).toHaveAttribute('aria-pressed', 'false');

  const cell = editor.locator('.cm-atomic-table td .cm-atomic-table-cell-source').first();
  await expect(cell).toBeVisible();
  await expect(cell).toHaveAttribute('contenteditable', 'false');

  // Clicking a cell then typing must leave the document untouched.
  const before = await cell.textContent();
  await cell.click();
  await page.keyboard.type('ZZZ');
  await expect(cell).toHaveText(before ?? '');
  await expect(editor).not.toContainText('ZZZ');

  // Switching to editing hands editability back.
  await page.getByTestId('edit-toggle').click();
  await expect(page.getByTestId('edit-toggle')).toHaveAttribute('aria-pressed', 'true');
  const editable = editor.locator('.cm-atomic-table td .cm-atomic-table-cell-source').first();
  await expect(editable).toHaveAttribute('contenteditable', 'true');
  await editable.click();
  await page.keyboard.type('ZZZ');
  await expect(editable).toContainText('ZZZ');
});
