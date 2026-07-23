import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * Review-diff history stepper: walk backward through a Concept's commits (issue
 * 05, extends 04).
 *
 * Drives the stepper bar in the read-only review view against the fake backend's
 * MULTI-commit git seam and asserts the user-visible behaviour:
 *  - the bar opens at `Working tree ↔ HEAD` (04's default), `newer →` disabled;
 *  - `← older` steps to `HEAD ↔ HEAD~1`, then `HEAD~1 ↔ HEAD~2`, re-rendering a
 *    DIFFERENT diff and showing the newer side's short hash + subject + date;
 *  - `← older` disables at the oldest pair; `newer →` walks back toward the
 *    working tree and disables there.
 *
 * The fake's `fileAtRev` returns the committed snapshot at HEAD and a
 * deterministically-altered variant at each older generation (a unique
 * `revision marker N` line per generation), so each pair's diff is distinct and
 * stable.
 */

async function openReview(page: Page, path: string) {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await tree.locator(`[data-path="${path}"]`).click();
  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  // Read is the default; enter editing so the working-tree edit below takes.
  await page.getByTestId('edit-toggle').click();

  // A working-tree edit so the position-0 (working ↔ HEAD) diff is non-empty.
  const content = editor.locator('.cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n\nA working-tree only sentence.');

  await page.getByTestId('review-toggle').click();
  const review = page.getByTestId('review-editor');
  await expect(review).toBeVisible();
  return review;
}

test('stepping older/newer walks consecutive commit pairs and updates the diff', async ({
  page,
}) => {
  const review = await openReview(page, 'concepts/codemirror.md');

  const bar = page.getByTestId('review-stepper');
  const label = page.getByTestId('review-stepper-label');
  const older = page.getByTestId('review-older');
  const newer = page.getByTestId('review-newer');
  await expect(bar).toBeVisible();

  // Position 0: working tree ↔ HEAD. `newer →` is bounded (already at the tree);
  // `← older` is available (there IS history). The working-tree edit shows.
  await expect(label).toHaveText('Working tree ↔ HEAD');
  await expect(newer).toBeDisabled();
  await expect(older).toBeEnabled();
  await expect(review).toContainText('A working-tree only sentence.');
  await expect(review).not.toContainText('revision marker');

  // Step older → HEAD ↔ HEAD~1. The bar shows the NEWEST commit (the newer side)
  // and the diff changes: the working-tree sentence is gone, HEAD~1's marker
  // (deleted at HEAD) appears. `newer →` is now enabled.
  await older.click();
  await expect(label).toHaveText('HEAD ↔ HEAD~1');
  await expect(page.getByTestId('review-stepper-hash')).toHaveText('a1b2c3d');
  await expect(page.getByTestId('review-stepper-subject')).toHaveText('Refine the concept');
  await expect(page.getByTestId('review-stepper-date')).toHaveText('yesterday');
  await expect(newer).toBeEnabled();
  await expect(review).toContainText('revision marker 1');
  await expect(review).not.toContainText('A working-tree only sentence.');

  // Step older again → HEAD~1 ↔ HEAD~2, the OLDEST pair. Different newer commit,
  // different diff (marker 2), and `← older` is now bounded.
  await older.click();
  await expect(label).toHaveText('HEAD~1 ↔ HEAD~2');
  await expect(page.getByTestId('review-stepper-hash')).toHaveText('0f1e2d3');
  await expect(page.getByTestId('review-stepper-subject')).toHaveText('Expand the details');
  await expect(review).toContainText('revision marker 2');
  await expect(older).toBeDisabled();
  await expect(newer).toBeEnabled();

  // Step newer twice → back to the default working ↔ HEAD comparison.
  await newer.click();
  await expect(label).toHaveText('HEAD ↔ HEAD~1');
  await expect(review).toContainText('revision marker 1');
  await newer.click();
  await expect(label).toHaveText('Working tree ↔ HEAD');
  await expect(newer).toBeDisabled();
  await expect(review).toContainText('A working-tree only sentence.');

  // The review buffer stays read-only across stepping.
  await expect(review.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
});

test('the stepper marks are red/green track-changes and hide raw delimiters', async ({
  page,
}) => {
  const review = await openReview(page, 'concepts/bundle.md');
  const older = page.getByTestId('review-older');

  // At an older pair the deleted marker renders as a delete (red) mark, with the
  // raw CriticMarkup delimiters hidden.
  await older.click();
  await expect(page.getByTestId('review-stepper-label')).toHaveText('HEAD ↔ HEAD~1');
  await expect(review.locator('.cm-critic-del').first()).toBeVisible();
  await expect(review).not.toContainText('{--');
  await expect(review).not.toContainText('--}');
});
