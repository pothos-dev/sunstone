import { test, expect } from '@playwright/test';

test('walking skeleton: tree renders and a Concept opens', async ({ page }) => {
  await page.goto('/');

  // The Bundle tree renders (fake backend fixture).
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // A known fixture entry is present in the tree. (Reserved files like index.md
  // are surfaced as folder affordances, not ordinary leaves — see the
  // reserved-files slice — so assert on an ordinary Concept here.)
  await expect(tree.locator('[data-path="concepts/codemirror.md"]')).toBeVisible();

  // Open a Concept by clicking its tree entry.
  await tree.locator('[data-path="concepts/codemirror.md"]').click();

  // Its content shows in the CM6 editor.
  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('CodeMirror 6 is the editor core');

  // Read is the default; the Edit toggle switches to an editable buffer (the
  // editing-boolean-edit-toggle slice). Enter editing, then confirm editability.
  await page.getByTestId('edit-toggle').click();
  const editable = await editor.locator('.cm-content').getAttribute('contenteditable');
  expect(editable).toBe('true');

  await page.screenshot({ path: 'tests/screenshots/walking-skeleton.png', fullPage: true });
});
