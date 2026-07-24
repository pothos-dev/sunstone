import { test, expect } from '@playwright/test';

/**
 * Slices: in-concept-find / in-concept-replace.
 *
 * Drives the in-Concept Find & Replace panel (the BUILT-IN @codemirror/search
 * panel, mounted ABOVE the editor and themed as editor chrome) against the fake
 * backend. Distinct from the cross-Bundle Search modal (Ctrl+Shift+F).
 *
 *  - Ctrl+F opens the find panel above the editor and focuses the find field.
 *  - Ctrl+F is a NO-OP when no Concept is open.
 *  - Typing a term highlights matches and navigates between them; Esc closes.
 *  - Replace (single) and Replace-all edit the BODY and persist via autosave.
 *  - A replace is undoable through CM history (Ctrl+Z).
 *
 * The panel is the built-in CM one; `openSearch` (cm.ts) tags it with
 * data-testid hooks (find-panel / find-input / replace-input / find-replace /
 * find-replace-all) for stable selection.
 */

/** Read the persisted on-disk content of a Concept from the fake backend. */
async function fileContent(page: import('@playwright/test').Page, path: string) {
  return page.evaluate(
    (p) =>
      (window as unknown as { __sunstoneFake: { files: Record<string, string> } })
        .__sunstoneFake.files[p],
    path,
  );
}

test('Ctrl+F is a no-op when no Concept is open', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();

  // No Concept selected yet: the placeholder shows and the editor is hidden.
  await expect(page.getByTestId('placeholder')).toBeVisible();

  await page.keyboard.press('Control+f');
  // No find panel appears.
  await expect(page.getByTestId('find-panel')).toHaveCount(0);
});

test('Ctrl+F opens the find panel above the editor, finds and navigates', async ({ page }) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('CodeMirror 6 is the editor core');

  // Read is the default; enter editing so the editor takes/keeps focus (Esc below
  // refocuses .cm-content, which a read-only view cannot hold).
  await page.getByTestId('edit-toggle').click();

  // --- Ctrl+F opens the panel and focuses the find field ---
  await page.keyboard.press('Control+f');
  const panel = page.getByTestId('find-panel');
  await expect(panel).toBeVisible();
  const findInput = page.getByTestId('find-input');
  await expect(findInput).toBeFocused();

  // The panel mounts ABOVE the editor content: its top is above .cm-content's.
  const panelBox = await panel.boundingBox();
  const contentBox = await editor.locator('.cm-content').boundingBox();
  expect(panelBox).not.toBeNull();
  expect(contentBox).not.toBeNull();
  expect(panelBox!.y).toBeLessThan(contentBox!.y);

  // --- Typing a term highlights matches ---
  // Type rather than fill: the built-in field commits the query on keyup.
  await findInput.pressSequentially('editor');
  await expect(editor.locator('.cm-searchMatch').first()).toBeVisible();

  // --- Navigate (Enter in the find field = find next): the current match
  // becomes the "selected" one and scrolls into view. ---
  await findInput.press('Enter');
  await expect(editor.locator('.cm-searchMatch-selected')).toHaveCount(1);
  const selectedText = await editor
    .locator('.cm-searchMatch-selected')
    .evaluate((el) => el.textContent ?? '');
  expect(selectedText.toLowerCase()).toContain('editor');

  // --- Esc closes the panel and refocuses the editor ---
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(editor.locator('.cm-content')).toBeFocused();
});

test('case-insensitive literal by default; toggles are present', async ({ page }) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('CodeMirror 6 is the editor core');

  await page.keyboard.press('Control+f');
  const panel = page.getByTestId('find-panel');
  await expect(panel).toBeVisible();

  // Default is case-INsensitive: lowercase "codemirror" matches "CodeMirror".
  await page.getByTestId('find-input').pressSequentially('codemirror');
  await expect(editor.locator('.cm-searchMatch').first()).toBeVisible();

  // The case / regexp / whole-word toggles are present in the panel.
  await expect(panel.locator('input[name=case]')).toBeVisible();
  await expect(panel.locator('input[name=re]')).toBeVisible();
  await expect(panel.locator('input[name=word]')).toBeVisible();
});

test('Replace (single) and Replace-all edit the body and persist via autosave', async ({
  page,
}) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('CodeMirror 6 is the editor core');

  // Read is the default; enter editing so Replace can edit the body.
  await page.getByTestId('edit-toggle').click();

  // --- Replace single: the body says "Sunstone layers OKF-aware extensions";
  // replace that single body occurrence of "Sunstone" with "Sunstone". ---
  await page.keyboard.press('Control+f');
  await expect(page.getByTestId('find-panel')).toBeVisible();
  await page.getByTestId('find-input').pressSequentially('Sunstone');
  await expect(editor.locator('.cm-searchMatch').first()).toBeVisible();
  await page.getByTestId('replace-input').pressSequentially('Sunstone');
  // Select the current match first (Enter = find next), then replace it.
  await page.getByTestId('find-input').press('Enter');
  await page.getByTestId('find-replace').click();
  await expect
    .poll(async () => (await fileContent(page, 'concepts/codemirror.md')).includes('Sunstone layers'))
    .toBe(true);

  // --- Replace all: "CodeMirror" appears twice in the BODY (the heading and
  // the first sentence); replace every body occurrence with "Sunstone". ---
  await page.getByTestId('find-input').fill('');
  await page.getByTestId('find-input').pressSequentially('CodeMirror');
  await expect(editor.locator('.cm-searchMatch').first()).toBeVisible();
  await page.getByTestId('replace-input').fill('');
  await page.getByTestId('replace-input').pressSequentially('Sunstone');
  await page.getByTestId('find-replace-all').click();

  const after = await (async () => {
    await expect
      .poll(async () => (await fileContent(page, 'concepts/codemirror.md')).includes('# Sunstone'))
      .toBe(true);
    return fileContent(page, 'concepts/codemirror.md');
  })();
  // Both body occurrences replaced (heading + first sentence).
  expect(after).toContain('# Sunstone');
  expect(after).toContain('Sunstone 6 is the editor core');

  // --- Frontmatter is untouched: the YAML block (incl. `title: CodeMirror`
  // and the `description: ... used by Sunstone.`) survives intact (ADR 0003). ---
  expect(after).toContain('title: CodeMirror');
  expect(after).toContain('used by Sunstone.');
  expect(after.startsWith('---\n')).toBe(true);

  // Persists across navigation (reopen shows the replaced body).
  await tree.locator('[data-path="concepts/bundle.md"]').click();
  await expect(editor).toContainText('A Bundle is the root folder');
  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  await expect(editor).toContainText('Sunstone layers OKF-aware extensions');
});

test('a replace is undoable through CM history', async ({ page }) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('CodeMirror 6 is the editor core');

  // Read is the default; enter editing so Replace edits the body and Ctrl+Z runs.
  await page.getByTestId('edit-toggle').click();

  await page.keyboard.press('Control+f');
  await expect(page.getByTestId('find-panel')).toBeVisible();
  await page.getByTestId('find-input').pressSequentially('CodeMirror');
  await expect(editor.locator('.cm-searchMatch').first()).toBeVisible();
  await page.getByTestId('replace-input').pressSequentially('Sunstone');
  await page.getByTestId('find-replace-all').click();

  // Body heading "# CodeMirror" becomes "# Sunstone" (frontmatter unchanged).
  await expect
    .poll(async () => (await fileContent(page, 'concepts/codemirror.md')).includes('# Sunstone'))
    .toBe(true);

  // Undo through CM history (focus the editor first so the keymap handles it).
  await editor.locator('.cm-content').click();
  await page.keyboard.press('Control+z');

  // The undo restores the body heading and persists back through autosave.
  await expect
    .poll(async () => (await fileContent(page, 'concepts/codemirror.md')).includes('# CodeMirror'))
    .toBe(true);
  expect(await fileContent(page, 'concepts/codemirror.md')).not.toContain('# Sunstone');
});
