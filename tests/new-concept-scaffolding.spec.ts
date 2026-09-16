import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';

/**
 * Slice: new-concept-scaffolding.
 *
 * A new Concept created from the tree opens spec-valid:
 *  - frontmatter STUB with an empty `type` and a `title` derived from the filename,
 *  - the Frontmatter Region is shown, editing is on, and the cursor lands at the
 *    end of the `type:` line so the author can fill in the one REQUIRED field,
 *  - typing a value there persists it.
 *
 * (Type autocomplete came with the Properties panel and returns as marker-gated
 * completion — ticket 02b, ADR 0009.)
 */

/** Open the context menu for a tree node by right-clicking its row. */
async function openRowMenu(page: Page, path: string) {
  const tree = page.getByTestId('tree');
  await tree.locator(`[data-row-path="${path}"]`).click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
}

test('new concept: scaffolds type/title and lands the cursor on `type`', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  // --- Create a new Concept "my-note" under concepts/ ---
  await openRowMenu(page, 'concepts');
  await page.getByTestId('context-menu').locator('[data-action="newConcept"]').click();
  await page.getByTestId('dialog-input').fill('my-note');
  await page.getByTestId('dialog-confirm').click();

  const created = 'concepts/my-note.md';
  await expect(tree.locator(`[data-path="${created}"]`)).toBeVisible();

  // --- The Frontmatter Region is revealed and shows the scaffolded stub ---
  const yaml = page.getByTestId('frontmatter').locator('.cm-content');
  await expect(yaml).toBeVisible();
  // title is humanized from the filename: "my-note" -> "My note".
  await expect(yaml).toContainText('title: My note');
  // type is present but EMPTY — and editing is on so it can be filled in.
  await expect(yaml).toContainText('type:');
  await expect(yaml).toHaveAttribute('contenteditable', 'true');

  // --- The cursor is at the end of the `type:` line (the user lands there) ---
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(document.activeElement?.closest('[data-region="frontmatter"] .cm-editor')),
      ),
    )
    .toBe(true);

  // --- Typing there fills the required field ---
  await page.keyboard.type(' reference');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __sunstoneFake: { files: Record<string, string> } })
            .__sunstoneFake.files['concepts/my-note.md'],
      ),
    )
    .toContain('type: reference');

  // The created file is immediately valid OKF: has type + title.
  const content = await page.evaluate(
    () =>
      (window as unknown as { __sunstoneFake: { files: Record<string, string> } })
        .__sunstoneFake.files['concepts/my-note.md'],
  );
  expect(content).toContain('type: reference');
  expect(content).toContain('title: My note');

  await page.screenshot({
    path: 'tests/screenshots/new-concept-scaffolding.png',
    fullPage: true,
  });
});
