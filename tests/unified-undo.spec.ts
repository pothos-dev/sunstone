import { test, expect, type Page } from '@playwright/test';

/**
 * Slice: unified-body-frontmatter-undo.
 *
 * One CodeMirror history spans BOTH the markdown body and the structured
 * frontmatter (frontmatter edits are `setFrontmatter` effects with an
 * `invertedEffects` inverse + `isolateHistory("full")`). Verifies:
 *  (a) editing body then a property, Ctrl+Z twice undoes both in reverse order
 *      and redo restores them,
 *  (b) Ctrl+Z works with focus in a Properties input (routed to the view),
 *  (c) switching Concepts resets history — undo cannot modify the previous one,
 *  (d) the panel undo/redo buttons work and disable at the stack ends.
 *
 * Asserts on persisted state (fake backend) + the live frontmatter inputs and
 * editor text, and uses real keyboard events as the existing suite does.
 */

/** Read the persisted raw markdown of a Concept from the fake backend. */
function persisted(page: Page, path: string): Promise<string> {
  return page.evaluate(
    (p) =>
      (window as unknown as { __sunstoneFake: { files: Record<string, string> } })
        .__sunstoneFake.files[p],
    path,
  );
}

test('unified undo: body then property undo/redo in reverse order', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.getByTestId('properties-toggle').click(); // Properties hidden by default
  await tree.locator('[data-path="concepts/codemirror.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('CodeMirror 6 is the editor core');

  // Read is the default; enter editing so the body is editable and undo/redo run.
  await page.getByTestId('edit-toggle').click();

  // 1) BODY edit: type a marker at the end of the document.
  const content = editor.locator('.cm-content');
  await content.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\nUNDO_BODY_MARKER');
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain('UNDO_BODY_MARKER');

  // 2) PROPERTY edit: change the title scalar (one discrete undo step).
  const titleInput = page.getByTestId('scalar-title');
  await titleInput.fill('CodeMirror Changed');
  await titleInput.blur();
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain('title: CodeMirror Changed');

  // Undo once (focus back in the editor) -> reverts the PROPERTY (most recent).
  await content.click();
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('scalar-title')).toHaveValue('CodeMirror');
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain('title: CodeMirror');
  // Body marker still present after the first undo.
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain('UNDO_BODY_MARKER');

  // Undo again -> reverts the BODY edit.
  await page.keyboard.press('Control+z');
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).not.toContain('UNDO_BODY_MARKER');

  // Redo twice -> restores body then property in chronological order.
  await page.keyboard.press('Control+y');
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain('UNDO_BODY_MARKER');
  await page.keyboard.press('Control+y');
  await expect(page.getByTestId('scalar-title')).toHaveValue('CodeMirror Changed');
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain('title: CodeMirror Changed');
});

test('unified undo: Ctrl+Z works with focus in a Properties input', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.getByTestId('properties-toggle').click(); // Properties hidden by default
  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  await expect(page.getByTestId('properties')).toBeVisible();

  // Read is the default; enter editing so the edit registers in the CM history.
  await page.getByTestId('edit-toggle').click();

  // Make a frontmatter edit, then commit it.
  const titleInput = page.getByTestId('scalar-title');
  await titleInput.fill('Focus In Panel');
  await titleInput.blur();
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain('title: Focus In Panel');

  // Focus another Properties input (description) — outside the CodeMirror DOM —
  // and press Ctrl+Z. The global handler routes it to the editor's history.
  const desc = page.getByTestId('scalar-description');
  await desc.click();
  await page.keyboard.press('Control+z');

  await expect(page.getByTestId('scalar-title')).toHaveValue('CodeMirror');
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain('title: CodeMirror');
});

test('unified undo: switching Concepts resets history', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.getByTestId('properties-toggle').click(); // Properties hidden by default
  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  await expect(page.getByTestId('properties')).toBeVisible();

  // Read is the default; enter editing (global mode, survives the switch below).
  await page.getByTestId('edit-toggle').click();

  // Edit a property on the FIRST Concept.
  const titleInput = page.getByTestId('scalar-title');
  await titleInput.fill('First Concept Edited');
  await titleInput.blur();
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain('title: First Concept Edited');

  // Switch to a DIFFERENT Concept.
  await tree.locator('[data-path="concepts/bundle.md"]').click();
  await expect(page.getByTestId('scalar-title')).toHaveValue('Bundle');

  // History is reset: the panel undo button is disabled, and Ctrl+Z does NOTHING
  // (cannot reach back into the previous Concept).
  const undoBtn = page.getByTestId('undo');
  await expect(undoBtn).toBeDisabled();

  const bundleBefore = await persisted(page, 'concepts/bundle.md');
  const editor = page.getByTestId('editor');
  await editor.locator('.cm-content').click();
  await page.keyboard.press('Control+z');

  // The previous Concept is untouched by the undo, and the current one too.
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain('title: First Concept Edited');
  await expect.poll(() => persisted(page, 'concepts/bundle.md')).toBe(bundleBefore);
});

test('unified undo: panel buttons work and disable at stack ends', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.getByTestId('properties-toggle').click(); // Properties hidden by default
  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  await expect(page.getByTestId('properties')).toBeVisible();

  // Read is the default; enter editing so the undo/redo panel buttons render.
  await page.getByTestId('edit-toggle').click();

  const undoBtn = page.getByTestId('undo');
  const redoBtn = page.getByTestId('redo');

  // Clean open: nothing to undo or redo.
  await expect(undoBtn).toBeDisabled();
  await expect(redoBtn).toBeDisabled();

  // Make one frontmatter edit.
  const titleInput = page.getByTestId('scalar-title');
  await titleInput.fill('Button Driven');
  await titleInput.blur();
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain('title: Button Driven');

  // Undo becomes available; redo still disabled.
  await expect(undoBtn).toBeEnabled();
  await expect(redoBtn).toBeDisabled();

  // Click undo -> reverts; now undo disabled (back at the bottom), redo enabled.
  await undoBtn.click();
  await expect(page.getByTestId('scalar-title')).toHaveValue('CodeMirror');
  await expect(undoBtn).toBeDisabled();
  await expect(redoBtn).toBeEnabled();
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain('title: CodeMirror');

  // Click redo -> re-applies; redo disabled again (top of stack), undo enabled.
  await redoBtn.click();
  await expect(page.getByTestId('scalar-title')).toHaveValue('Button Driven');
  await expect(redoBtn).toBeDisabled();
  await expect(undoBtn).toBeEnabled();
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain('title: Button Driven');
});
