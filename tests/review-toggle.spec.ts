import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * Review changes toggle: working-tree ↔ HEAD (issue 04).
 *
 * Drives the NavBar "Review changes" toggle against the fake backend's git seam
 * and asserts the user-visible behaviour:
 *  - enable → the open Concept's changes since HEAD render as red/green
 *    CriticMarkup track-change marks in a read-only buffer;
 *  - the review buffer is read-only and its marked text never becomes the
 *    editable document (the working-tree content is restored on exit);
 *  - Esc and toggling off both return to normal editing at the working tree;
 *  - the toggle is DISABLED with an explanatory tooltip for a Concept with no
 *    reviewable history (an untracked, runtime-created file);
 *  - a pre-existing highlight/comment annotation still renders in review view.
 *
 * The fake's `fileAtRev(path, 'HEAD')` returns the COMMITTED snapshot of the
 * fixture; the working tree is the live editor buffer, so an edit made in the
 * test produces a stable, non-empty diff.
 */

type FakeWindow = Window & {
  __sunstoneFake: {
    simulateExternalChange: (kind: string, path: string, content?: string) => void;
    files: Record<string, string>;
  };
};

async function openFixture(page: Page, path: string) {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await tree.locator(`[data-path="${path}"]`).click();
  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  // Read is the default; enter editing so the working-tree edits below take.
  await page.getByTestId('edit-toggle').click();
  return editor;
}

test('enabling review shows working-tree ↔ HEAD changes as red/green marks; exit restores editing', async ({
  page,
}) => {
  const editor = await openFixture(page, 'concepts/codemirror.md');
  await expect(editor).toContainText('CodeMirror 6 is the editor core');

  const reviewToggle = page.getByTestId('review-toggle');
  await expect(reviewToggle).toBeEnabled();
  await expect(reviewToggle).toHaveAttribute('aria-pressed', 'false');

  // Make a genuine working-tree edit so the diff against HEAD is non-empty:
  // append a word to the first body sentence.
  const content = editor.locator('.cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n\nA freshly added review paragraph.');

  // Enable review.
  await reviewToggle.click();
  await expect(reviewToggle).toHaveAttribute('aria-pressed', 'true');

  const review = page.getByTestId('review-editor');
  await expect(review).toBeVisible();
  // The added paragraph renders as a green (addition) mark; the delimiters are
  // hidden. At least one add mark must be present.
  await expect(review.locator('.cm-critic-add').first()).toBeVisible();
  await expect(review).toContainText('freshly added review paragraph');
  await expect(review).not.toContainText('{++');
  await expect(review).not.toContainText('++}');

  // The review buffer is READ-ONLY.
  await expect(review.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  // The normal editor is hidden while review is active.
  await expect(editor).toBeHidden();

  // Exit by toggling off → back to normal editable content, no marks, and the
  // working-tree edit is intact.
  await reviewToggle.click();
  await expect(reviewToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('review-editor')).toHaveCount(0);
  await expect(editor).toBeVisible();
  await expect(editor.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
  await expect(editor).toContainText('A freshly added review paragraph');
  await expect(editor.locator('.cm-critic-add')).toHaveCount(0);

  await page.screenshot({ path: 'tests/screenshots/review-toggle.png' });
});

test('Esc exits the review view and returns to normal editing', async ({ page }) => {
  const editor = await openFixture(page, 'concepts/bundle.md');
  await expect(editor).toContainText('is the root folder opened by Sunstone');

  // Edit so the review diff is non-empty, then enable review.
  const content = editor.locator('.cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n\nAnother edit for review.');

  const reviewToggle = page.getByTestId('review-toggle');
  await reviewToggle.click();
  await expect(page.getByTestId('review-editor')).toBeVisible();
  await expect(reviewToggle).toHaveAttribute('aria-pressed', 'true');

  // Esc exits review.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('review-editor')).toHaveCount(0);
  await expect(reviewToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(editor).toBeVisible();
  await expect(editor.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
});

test('pre-existing annotations still render in the review view', async ({ page }) => {
  // `concepts/annotated.md` is COMMITTED with a highlight+comment annotation, so
  // editing an unrelated line leaves that annotated line unchanged between HEAD
  // and the working tree — the annotation renders normally in review (not nested
  // inside a diff span).
  const editor = await openFixture(page, 'concepts/annotated.md');
  await expect(editor).toContainText('predates any review');
  // The annotation already renders as a highlight in normal editing.
  await expect(editor.locator('.cm-critic-highlight').first()).toBeVisible();

  // Edit an UNRELATED line (append a paragraph) so the annotated line is unchanged.
  const content = editor.locator('.cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n\nA brand new trailing paragraph.');

  await page.getByTestId('review-toggle').click();
  const review = page.getByTestId('review-editor');
  await expect(review).toBeVisible();
  // The edit shows as a green addition mark...
  await expect(review.locator('.cm-critic-add').first()).toBeVisible();
  await expect(review).toContainText('brand new trailing paragraph');
  // ...and the pre-existing highlight annotation still renders (not suppressed),
  // with its raw comment delimiters hidden.
  await expect(review.locator('.cm-critic-highlight').first()).toBeVisible();
  await expect(review).not.toContainText('{>>');
  await expect(review).not.toContainText('<<}');
});

test('the toggle is disabled with a tooltip for a Concept with no reviewable history', async ({
  page,
}) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // Create a NEW Concept at runtime: it exists in the working tree but not in
  // the committed snapshot, so the fake git seam reports it `untracked`.
  await page.waitForFunction(() => '__sunstoneFake' in window);
  await page.evaluate(() => {
    (window as unknown as FakeWindow).__sunstoneFake.simulateExternalChange(
      'created',
      'untracked-note.md',
      '---\ntype: concept\ntitle: Untracked\n---\n\n# Untracked\n\nBrand new.\n',
    );
  });
  await expect(tree.locator('[data-path="untracked-note.md"]')).toBeVisible();
  await tree.locator('[data-path="untracked-note.md"]').click();
  await expect(page.getByTestId('editor')).toBeVisible();

  const reviewToggle = page.getByTestId('review-toggle');
  await expect(reviewToggle).toBeDisabled();
  await expect(reviewToggle).toHaveAttribute('title', /untracked/i);
});
