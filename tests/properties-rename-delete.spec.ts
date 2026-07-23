import { test, expect, type Page } from '@playwright/test';

/**
 * Slice: rename-and-delete-properties.
 *
 * Drives the Properties panel against the fake backend:
 *  - rename a key (commit on blur) and assert it persists,
 *  - revert on empty key and on duplicate key (no change written),
 *  - delete a property and assert it is gone from disk,
 *  - delete the LAST property -> the whole `---…---` block disappears,
 *  - rename a COMPLEX/unknown key and assert the preserved value moves to the
 *    new key intact.
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

test('properties: rename key commits on blur and persists', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  // Properties is hidden by default now (global toggle); switch it on.
  await page.getByTestId('properties-toggle').click();
  await page.locator('[data-path="concepts/codemirror.md"]').click();
  await expect(page.getByTestId('properties')).toBeVisible();

  // Rename `description` -> `summary`.
  const keyInput = page.getByTestId('key-description');
  await keyInput.fill('summary');
  await keyInput.blur();

  await expect
    .poll(() => persisted(page, 'concepts/codemirror.md'))
    .toContain('summary: The editor core used by Sunstone.');
  const after = await persisted(page, 'concepts/codemirror.md');
  expect(after).not.toContain('description:');
  // The value moved intact; other keys untouched.
  expect(after).toContain('type: concept');
  expect(after).toContain('title: CodeMirror');
});

test('properties: rename reverts on empty and on duplicate', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  // Properties is hidden by default now (global toggle); switch it on.
  await page.getByTestId('properties-toggle').click();
  await page.locator('[data-path="concepts/codemirror.md"]').click();
  await expect(page.getByTestId('properties')).toBeVisible();

  const before = await persisted(page, 'concepts/codemirror.md');

  // Empty -> revert (no write). The live key text is restored.
  const titleKey = page.getByTestId('key-title');
  await titleKey.fill('');
  await titleKey.blur();
  await expect(page.getByTestId('key-title')).toHaveValue('title');
  expect(await persisted(page, 'concepts/codemirror.md')).toBe(before);

  // Duplicate (`title` collides with existing) -> revert.
  const descKey = page.getByTestId('key-description');
  await descKey.fill('title');
  await descKey.blur();
  await expect(page.getByTestId('key-description')).toHaveValue('description');
  expect(await persisted(page, 'concepts/codemirror.md')).toBe(before);
});

test('properties: delete a property persists the removal', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  // Properties is hidden by default now (global toggle); switch it on.
  await page.getByTestId('properties-toggle').click();
  await page.locator('[data-path="concepts/codemirror.md"]').click();
  await expect(page.getByTestId('properties')).toBeVisible();

  await page.getByTestId('delete-description').click();

  await expect
    .poll(async () =>
      /description:/.test(await persisted(page, 'concepts/codemirror.md')),
    )
    .toBe(false);
  // Sibling keys survive.
  const after = await persisted(page, 'concepts/codemirror.md');
  expect(after).toContain('type: concept');
  expect(after).toContain('title: CodeMirror');
});

test('properties: deleting the last property drops the frontmatter block', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  // Properties is hidden by default now (global toggle); switch it on.
  await page.getByTestId('properties-toggle').click();
  await page.locator('[data-path="concepts/bundle.md"]').click();
  await expect(page.getByTestId('properties')).toBeVisible();

  // bundle.md has 4 properties: type, title, description, tags. Delete all.
  for (const key of ['type', 'title', 'description', 'tags']) {
    await page.getByTestId(`delete-${key}`).click();
  }

  // The panel is globally shown, so deleting every property leaves it rendered
  // with the +Text/+List controls still available to add the next one.
  await expect(page.getByTestId('properties')).toBeVisible();
  await expect(page.getByTestId('add-text')).toBeVisible();
  await expect
    .poll(() => persisted(page, 'concepts/bundle.md'))
    .not.toContain('---');
  // Body survived: it starts directly with the heading.
  const after = await persisted(page, 'concepts/bundle.md');
  expect(after.trimStart().startsWith('# Bundle')).toBe(true);
});

test('properties: renaming a complex/unknown key preserves the value', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  // Properties is hidden by default now (global toggle); switch it on.
  await page.getByTestId('properties-toggle').click();
  await page.locator('[data-path="concepts/complex-frontmatter.md"]').click();
  await expect(page.getByTestId('properties')).toBeVisible();

  const nestedBlock =
    'nested:\n  author: jane\n  reviewers:\n    - bob\n    - carol\n';
  const renamedNested =
    'meta:\n  author: jane\n  reviewers:\n    - bob\n    - carol\n';

  // Rename the complex `nested` map -> `meta`. The value (block) must move
  // intact under the new key.
  const nestedKey = page.getByTestId('key-nested');
  await nestedKey.fill('meta');
  await nestedKey.blur();

  await expect
    .poll(() => persisted(page, 'concepts/complex-frontmatter.md'))
    .toContain(renamedNested);
  const after = await persisted(page, 'concepts/complex-frontmatter.md');
  expect(after).not.toContain(nestedBlock);

  // Rename the unknown scalar key `custom_field` -> `extra`; value preserved.
  const customKey = page.getByTestId('key-custom_field');
  await customKey.fill('extra');
  await customKey.blur();
  await expect
    .poll(() => persisted(page, 'concepts/complex-frontmatter.md'))
    .toContain('extra: keep me intact');
});
