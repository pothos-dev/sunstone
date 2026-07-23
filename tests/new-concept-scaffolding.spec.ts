import { test, expect, type Page } from '@playwright/test';

/**
 * Slice: new-concept-scaffolding.
 *
 * A new Concept created from the tree opens spec-valid:
 *  - frontmatter STUB with an empty `type` and a `title` derived from the filename,
 *  - the `type` Properties input is FOCUSED so the user lands there,
 *  - the `type` field autocompletes against existing Bundle types (a datalist),
 *    while still allowing a brand-new type to be typed freely.
 */

/** Open the context menu for a tree node by right-clicking its row. */
async function openRowMenu(page: Page, path: string) {
  const tree = page.getByTestId('tree');
  await tree.locator(`[data-row-path="${path}"]`).click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
}

test('new concept: scaffolds type/title, focuses type, autocompletes types', async ({
  page,
}) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  // Properties is hidden by default (global toggle); switch it on so the
  // scaffolded stub + focused `type` field render.
  await page.getByTestId('properties-toggle').click();

  // --- Create a new Concept "my-note" under concepts/ ---
  await openRowMenu(page, 'concepts');
  await page.getByTestId('context-menu').locator('[data-action="newConcept"]').click();
  await page.getByTestId('dialog-input').fill('my-note');
  await page.getByTestId('dialog-confirm').click();

  const created = 'concepts/my-note.md';
  await expect(tree.locator(`[data-path="${created}"]`)).toBeVisible();

  // --- The Properties panel shows the scaffolded stub ---
  const properties = page.getByTestId('properties');
  await expect(properties).toBeVisible();
  // title is humanized from the filename: "my-note" -> "My note".
  await expect(page.getByTestId('scalar-title')).toHaveValue('My note');
  // type is present but EMPTY.
  await expect(page.getByTestId('scalar-type')).toHaveValue('');

  // --- The type input is FOCUSED (the user lands there) ---
  await expect(page.getByTestId('scalar-type')).toBeFocused();

  // --- type autocomplete: datalist lists existing Bundle types ---
  await expect(page.getByTestId('type-suggestions')).toHaveCount(1);
  const options = await page
    .getByTestId('type-suggestions')
    .locator('option')
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  // Fixture distinct types include concept, index, log.
  expect(options).toContain('concept');
  expect(options).toContain('index');

  // --- A brand-new type can still be typed freely ---
  const typeInput = page.getByTestId('scalar-type');
  await typeInput.fill('reference');
  await typeInput.blur();
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
