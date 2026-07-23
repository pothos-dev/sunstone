import { test, expect, type Page } from '@playwright/test';

/**
 * Bug fix: value edits in the Properties panel are keyed by the row's positional
 * id, not by `prop.key`. Two parts:
 *
 *  (1) FORBID DUPLICATES — the key-commit path already refuses a rename or a new
 *      key that collides with an existing key (rename reverts; a new row is
 *      discarded). This spec adds an explicit assertion that the rename-collide
 *      path reverts, keyed off the duplicate-keys fixture.
 *
 *  (2) ROW-ID KEYING (defensive) — a file authored OUTSIDE the app can still
 *      reach a duplicate-key state. `concepts/duplicate-keys.md` has two `title`
 *      keys. Editing the SECOND duplicate row must update the SECOND row, not
 *      the first matching key. Before the fix, `editScalar`/`setListItems`/
 *      `addChip`/`removeChip` (and `chipDrafts`) addressed by `prop.key`, so the
 *      edit landed on the first match. After the fix they address by row id.
 */

/** Read the persisted raw markdown of a Concept from the fake backend. */
function persisted(page: Page, path: string): Promise<string> {
  return page.evaluate(
    (p) =>
      (
        window as unknown as { __sunstoneFake: { files: Record<string, string> } }
      ).__sunstoneFake.files[p],
    path,
  );
}

/** Open a Concept and wait for the Properties panel to render. */
async function open(page: Page, path: string) {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  await page.getByTestId('properties-toggle').click(); // Properties hidden by default
  await page.locator(`[data-path="${path}"]`).click();
  await expect(page.getByTestId('properties')).toBeVisible();
}

test('properties: editing the SECOND duplicate-key row updates the second row, not the first', async ({
  page,
}) => {
  await open(page, 'concepts/duplicate-keys.md');

  // The externally-authored file has two `title` rows. Both render as scalar
  // inputs sharing the same testid; address them positionally.
  const titles = page.getByTestId('scalar-title');
  await expect(titles).toHaveCount(2);
  await expect(titles.nth(0)).toHaveValue('First Title');
  await expect(titles.nth(1)).toHaveValue('Second Title');

  // Edit the SECOND title row. It must write to the second row only — the first
  // row's value must stay intact, and the document order must be preserved
  // (First Title still precedes the edited Second).
  await titles.nth(1).fill('Edited Second');
  await titles.nth(1).blur();

  await expect
    .poll(() => persisted(page, 'concepts/duplicate-keys.md'))
    .toContain('title: Edited Second');

  const after = await persisted(page, 'concepts/duplicate-keys.md');
  // The first duplicate row is untouched...
  expect(after).toContain('title: First Title');
  // ...and stays first in document order (positional-id ↔ array-index contract).
  expect(after.indexOf('title: First Title')).toBeLessThan(
    after.indexOf('title: Edited Second'),
  );

  // The inputs reflect the new state: first unchanged, second edited.
  await expect(titles.nth(0)).toHaveValue('First Title');
  await expect(titles.nth(1)).toHaveValue('Edited Second');
});

test('properties: renaming a key onto an existing key is rejected (reverts)', async ({
  page,
}) => {
  await open(page, 'concepts/duplicate-keys.md');

  const before = await persisted(page, 'concepts/duplicate-keys.md');

  // Rename `tags` -> `type` (already present) — a duplicate. It must revert: the
  // live key text is restored and nothing is written.
  const tagsKey = page.getByTestId('key-tags');
  await tagsKey.fill('type');
  await tagsKey.blur();
  await expect(page.getByTestId('key-tags')).toHaveValue('tags');
  expect(await persisted(page, 'concepts/duplicate-keys.md')).toBe(before);
});
