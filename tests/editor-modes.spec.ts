import { test, expect } from './fixtures';

/**
 * The editor mode collapsed to a boolean `editing` with a single Edit toggle in
 * the concept header (editing-boolean-edit-toggle):
 *  - Read (the DEFAULT): every line renders (no raw markup even on the clicked
 *    line) and the document is read-only.
 *  - Editing (old "hybrid"): inactive lines render styled; the cursor line
 *    reveals raw markup; the document is editable.
 * Toggling reconfigures the view in place (no rebuild), so the document survives
 * the round-trip.
 */
test('editor mode: Edit toggle switches render + editability', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await tree.locator('[data-path="concepts/editor/live-preview.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('Obsidian-style hybrid editing');

  const content = editor.locator('.cm-content');
  const h1 = editor.locator('.cm-atomic-h1');
  const editToggle = page.getByTestId('edit-toggle');

  // --- Read is the default -------------------------------------------------
  await expect(editToggle).toHaveAttribute('aria-pressed', 'false');
  // Decorations render (heading is styled) and the read-only facet is applied.
  await expect(h1.first()).toBeVisible();
  await expect(content).toHaveAttribute('contenteditable', 'false');
  // Reading ignores the cursor: clicking the heading does NOT reveal raw markup
  // (atomic-editor `alwaysRender`).
  await h1.first().click();
  await expect(editor).not.toContainText('# Live Preview');
  // Undo/redo are hidden in read mode (nothing to undo).
  await expect(page.getByTestId('undo')).toHaveCount(0);
  await expect(page.getByTestId('redo')).toHaveCount(0);

  // --- Editing: editable + hybrid reveal-on-cursor -------------------------
  await editToggle.click();
  await expect(editToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(content).toHaveAttribute('contenteditable', 'true');
  // Undo/redo appear once editing.
  await expect(page.getByTestId('undo')).toBeVisible();
  await expect(page.getByTestId('redo')).toBeVisible();
  // Heading still renders styled on inactive lines...
  await expect(h1.first()).toBeVisible();
  // ...and clicking it reveals its raw markup on the active line.
  await h1.first().click();
  const activeLine = editor.locator('.cm-activeLine').first();
  await expect(activeLine).toContainText('# Live Preview');

  // --- Back to Read: read-only restored ------------------------------------
  await editToggle.click();
  await expect(editToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(content).toHaveAttribute('contenteditable', 'false');
});

/**
 * The chosen mode is persisted per-Bundle and restored on relaunch
 * (persist-editor-mode): switch to Editing (the non-default), reload the app, and
 * the restored Concept opens in editing (editable, no rebuild-back-to-default).
 */
test('editor mode: chosen mode persists across a reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();

  // The fake backend is localStorage-backed and (under the shared CDP browser)
  // survives across runs, so clear it and reload to boot from a clean session.
  await page.evaluate(() => window.localStorage.setItem('sunstone:bundleState:/fake/bundle', JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'] })));
  await page.reload();

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await tree.locator('[data-path="concepts/editor/live-preview.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();

  // Switch to Editing and confirm it took.
  await page.getByTestId('edit-toggle').click();
  await expect(page.getByTestId('edit-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(editor.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');

  // Wait for the debounced save to flush both the open Concept and the mode to
  // localStorage before reloading (the reload restores exactly what's persisted).
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('sunstone:bundleState:/fake/bundle');
        if (raw === null) return null;
        return JSON.parse(raw) as { lastOpenConcept: string | null; editorMode?: string };
      }),
    )
    .toMatchObject({ lastOpenConcept: 'concepts/editor/live-preview.md', editorMode: 'editing' });

  // Reload: the last-open Concept reopens and should be in editing mode again.
  await page.reload();
  await expect(editor).toBeVisible();
  await expect(page.getByTestId('edit-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(editor.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
});

/**
 * The Edit toggle is disabled until a Concept is open (mode is meaningless with
 * no document), and enables once one is.
 */
test('editor mode: Edit toggle is disabled until a Concept is open', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  const editToggle = page.getByTestId('edit-toggle');
  await expect(editToggle).toBeDisabled();

  await tree.locator('[data-path="concepts/editor/live-preview.md"]').click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(editToggle).toBeEnabled();
});
