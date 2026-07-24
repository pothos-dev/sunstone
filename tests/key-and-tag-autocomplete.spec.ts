import { test, expect, type Page } from '@playwright/test';

/**
 * Slice: key-and-tag-autocomplete.
 *
 * Verifies the Properties panel's two autocomplete sources against the fake
 * backend (datalist options are present in the DOM even though the native
 * dropdown is not rendered until focus):
 *  - the key-name datalist offers the OKF recommended keys ∪ distinct keys used
 *    across OTHER bundle documents (so a producer-defined key like `custom_field`
 *    from `complex-frontmatter.md` appears);
 *  - the tag-value datalist offers distinct tag values used across the Bundle.
 * Both inputs reference their datalist via `list=`.
 */

/** Collect the `value`s of the options inside a datalist by id. */
function datalistValues(page: Page, id: string): Promise<string[]> {
  return page.evaluate(
    (datalistId) =>
      Array.from(document.querySelectorAll(`#${datalistId} option`)).map(
        (o) => (o as HTMLOptionElement).value,
      ),
    id,
  );
}

async function open(page: Page, path: string) {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  await page.getByTestId('properties-toggle').click(); // Properties hidden by default
  await page.locator(`[data-path="${path}"]`).click();
  await expect(page.getByTestId('properties')).toBeVisible();
}

test('key autocomplete offers OKF keys plus a key used elsewhere in the bundle', async ({
  page,
}) => {
  await open(page, 'concepts/codemirror.md');

  // The key inputs reference the shared key datalist.
  await expect(page.getByTestId('key-type')).toHaveAttribute('list', 'key-suggestions');

  const values = await datalistValues(page, 'key-suggestions');

  // OKF recommended keys are always present (seeded client-side).
  for (const okf of ['type', 'title', 'description', 'resource', 'tags', 'timestamp']) {
    expect(values).toContain(okf);
  }

  // A producer-defined key used elsewhere (concepts/complex-frontmatter.md) is
  // included via the bundle scan, even though it is not OKF.
  expect(values).toContain('custom_field');
});

test('tag autocomplete offers distinct tag values from the bundle', async ({ page }) => {
  await open(page, 'concepts/codemirror.md');

  // The `tags` list field's chip input references the tag datalist.
  await expect(page.getByTestId('chip-add-tags')).toHaveAttribute('list', 'tag-suggestions');

  const values = await datalistValues(page, 'tag-suggestions');

  // Tags seeded across the fixture bundle (index.md, codemirror.md, ...).
  for (const tag of ['okf', 'demo', 'editor', 'dependency']) {
    expect(values).toContain(tag);
  }

  // No OKF tag vocabulary: every suggestion is a real bundle tag (non-empty).
  expect(values.length).toBeGreaterThan(0);
  expect(values.every((v) => v.trim() !== '')).toBe(true);
});
