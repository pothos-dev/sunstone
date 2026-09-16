import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';

/**
 * Slice: unified-body-frontmatter-undo, re-based on ADR 0008.
 *
 * ONE CodeMirror history spans BOTH the markdown body and the frontmatter, even
 * though the frontmatter now lives in its own editor: the body editor owns the
 * stack, frontmatter edits arrive as `setFrontmatter` effects with an
 * `invertedEffects` inverse, and the YAML editor forwards undo/redo there.
 * Verifies:
 *  (a) editing body then frontmatter, Ctrl+Z twice undoes both in reverse order
 *      and redo restores them,
 *  (b) a run of keystrokes in the YAML is ONE undo step (grouped per idle pause),
 *      and undoing it moves focus to the surface it changed,
 *  (c) switching Concepts resets history — undo cannot modify the previous one,
 *  (d) the header undo/redo buttons work and disable at the stack ends.
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

/** The Frontmatter Region's YAML editor content. */
function yamlOf(page: Page) {
  return page.getByTestId('frontmatter').locator('.cm-content');
}

/** Append `text` to the end of the frontmatter's `title:` line. */
async function appendToTitle(page: Page, text: string) {
  await yamlOf(page).getByText('title:', { exact: false }).first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
}

test('unified undo: body then frontmatter undo/redo in reverse order', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.getByTestId('frontmatter-toggle').click(); // collapsed by default
  await tree.locator('[data-path="concepts/codemirror.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('CodeMirror 6 is the editor core');

  // Read is the default; enter editing so both surfaces are editable.
  await page.getByTestId('edit-toggle').click();

  // 1) BODY edit: type a marker at the end of the document.
  const content = editor.locator('.cm-content');
  await content.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\nUNDO_BODY_MARKER');
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain('UNDO_BODY_MARKER');

  // 2) FRONTMATTER edit: one run of keystrokes = one undo step.
  await appendToTitle(page, ' Changed');
  await expect
    .poll(() => persisted(page, 'concepts/codemirror.md'))
    .toContain('title: CodeMirror Changed');

  // Undo once (focus back in the body) -> reverts the FRONTMATTER (most recent).
  await content.click();
  await page.keyboard.press('Control+z');
  await expect(yamlOf(page)).toContainText('title: CodeMirror');
  await expect(yamlOf(page)).not.toContainText('CodeMirror Changed');
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain('title: CodeMirror');
  // Body marker still present after the first undo.
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain('UNDO_BODY_MARKER');

  // Undo again -> reverts the BODY edit.
  await page.keyboard.press('Control+z');
  await expect
    .poll(() => persisted(page, 'concepts/codemirror.md'))
    .not.toContain('UNDO_BODY_MARKER');

  // Redo twice -> restores body then frontmatter in chronological order.
  await page.keyboard.press('Control+y');
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain('UNDO_BODY_MARKER');
  await page.keyboard.press('Control+y');
  await expect(yamlOf(page)).toContainText('title: CodeMirror Changed');
  await expect
    .poll(() => persisted(page, 'concepts/codemirror.md'))
    .toContain('title: CodeMirror Changed');
});

test('unified undo: a run of YAML keystrokes is one step, and undo lands focus on it', async ({
  page,
}) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.getByTestId('frontmatter-toggle').click();
  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  await expect(page.getByTestId('frontmatter')).toBeVisible();
  await page.getByTestId('edit-toggle').click();

  // Eight keystrokes in one run.
  await appendToTitle(page, ' Six Rev');
  await expect
    .poll(() => persisted(page, 'concepts/codemirror.md'))
    .toContain('title: CodeMirror Six Rev');

  // ONE Ctrl+Z (pressed inside the YAML editor, forwarded to the body editor's
  // history) reverts the WHOLE run, not one character.
  await page.keyboard.press('Control+z');
  await expect(yamlOf(page)).toContainText('title: CodeMirror');
  await expect(yamlOf(page)).not.toContainText('Six Rev');

  // Focus follows what was undone: the step changed the frontmatter, so the
  // cursor is in the YAML editor — not the body.
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(document.activeElement?.closest('[data-region="frontmatter"] .cm-editor')),
      ),
    )
    .toBe(true);
});

test('unified undo: switching Concepts resets history', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.getByTestId('frontmatter-toggle').click();
  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  await expect(page.getByTestId('frontmatter')).toBeVisible();

  // Read is the default; enter editing (global mode, survives the switch below).
  await page.getByTestId('edit-toggle').click();

  // Edit the frontmatter of the FIRST Concept.
  await appendToTitle(page, ' First');
  await expect
    .poll(() => persisted(page, 'concepts/codemirror.md'))
    .toContain('title: CodeMirror First');

  // Switch to a DIFFERENT Concept.
  await tree.locator('[data-path="concepts/bundle.md"]').click();
  await expect(yamlOf(page)).toContainText('title: Bundle');

  // History is reset: the header undo button is disabled, and Ctrl+Z does
  // NOTHING (cannot reach back into the previous Concept).
  const undoBtn = page.getByTestId('undo');
  await expect(undoBtn).toBeDisabled();

  const bundleBefore = await persisted(page, 'concepts/bundle.md');
  const editor = page.getByTestId('editor');
  await editor.locator('.cm-content').click();
  await page.keyboard.press('Control+z');

  // The previous Concept is untouched by the undo, and the current one too.
  await expect
    .poll(() => persisted(page, 'concepts/codemirror.md'))
    .toContain('title: CodeMirror First');
  await expect.poll(() => persisted(page, 'concepts/bundle.md')).toBe(bundleBefore);
});

test('unified undo: header buttons work and disable at stack ends', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.getByTestId('frontmatter-toggle').click();
  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  await expect(page.getByTestId('frontmatter')).toBeVisible();

  // Read is the default; enter editing so the undo/redo buttons render.
  await page.getByTestId('edit-toggle').click();

  const undoBtn = page.getByTestId('undo');
  const redoBtn = page.getByTestId('redo');

  // Clean open: nothing to undo or redo.
  await expect(undoBtn).toBeDisabled();
  await expect(redoBtn).toBeDisabled();

  // Make one frontmatter edit.
  await appendToTitle(page, ' Button Driven');
  await expect
    .poll(() => persisted(page, 'concepts/codemirror.md'))
    .toContain('title: CodeMirror Button Driven');

  // Undo becomes available; redo still disabled.
  await expect(undoBtn).toBeEnabled();
  await expect(redoBtn).toBeDisabled();

  // Click undo -> reverts; now undo disabled (back at the bottom), redo enabled.
  await undoBtn.click();
  await expect(yamlOf(page)).not.toContainText('Button Driven');
  await expect(undoBtn).toBeDisabled();
  await expect(redoBtn).toBeEnabled();
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain('title: CodeMirror');

  // Click redo -> re-applies; redo disabled again (top of stack), undo enabled.
  await redoBtn.click();
  await expect(yamlOf(page)).toContainText('title: CodeMirror Button Driven');
  await expect(redoBtn).toBeDisabled();
  await expect(undoBtn).toBeEnabled();
  await expect
    .poll(() => persisted(page, 'concepts/codemirror.md'))
    .toContain('title: CodeMirror Button Driven');
});
