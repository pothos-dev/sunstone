import { test, expect } from './fixtures';

/**
 * Verification: in Reading (view) mode the WHOLE link follows the link, not
 * just the trailing open-in-new icon. In hybrid/live the link text stays
 * editable so only the icon opens (see links-navigation.spec.ts); reading view
 * is read-only, so a click anywhere on the link text navigates.
 */
test('read mode: clicking link TEXT (not the icon) follows the link', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await tree.locator('[data-path="concepts/bundle.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('A Bundle is the root folder');

  // Read is the default mode — the whole link is clickable here.
  await expect(page.getByTestId('edit-toggle')).toHaveAttribute('aria-pressed', 'false');

  const link = editor.locator('.cm-atomic-link', { hasText: 'CodeMirror' }).first();
  const box = await link.boundingBox();
  if (!box) throw new Error('CodeMirror link not found');

  // Click the CENTRE of the link text — well away from the trailing icon zone.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  await expect(editor).toContainText('CodeMirror 6 is the editor core');
  await expect(
    page.locator('[data-path="concepts/codemirror.md"]'),
  ).toHaveClass(/selected/);
});
