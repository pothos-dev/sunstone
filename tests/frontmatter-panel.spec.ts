import { test, expect, type Page } from '@playwright/test';

/**
 * Slice: frontmatter-properties-panel (ADR 0002, flat key/value model).
 *
 * Drives the Properties panel against the fake backend:
 *  - opens a Concept and asserts type/title/tags render (tags as chips),
 *  - edits a scalar and asserts it persists via the fake backend,
 *  - adds and removes a tag chip,
 *  - MOST IMPORTANT: opens a Concept with nested/complex frontmatter, edits a
 *    simple scalar, and asserts the complex value round-trips byte-for-byte.
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

test('properties panel: typed inputs, scalar persist, tag chips', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  // Properties is hidden by default (global toggle); switch it on.
  await page.getByTestId('properties-toggle').click();

  await tree.locator('[data-path="concepts/codemirror.md"]').click();

  const properties = page.getByTestId('properties');
  await expect(properties).toBeVisible();

  // type/title render as scalar text inputs; tags renders as chips.
  await expect(page.getByTestId('scalar-type')).toHaveValue('concept');
  await expect(page.getByTestId('scalar-title')).toHaveValue('CodeMirror');
  const tagChips = page.getByTestId('chip-tags');
  await expect(tagChips).toHaveCount(2); // editor, dependency

  // Edit the title scalar; it must persist via the autosave path.
  const titleInput = page.getByTestId('scalar-title');
  await titleInput.fill('CodeMirror Six');
  await titleInput.blur();
  await expect
    .poll(() => persisted(page, 'concepts/codemirror.md'))
    .toContain('title: CodeMirror Six');

  // Add a tag chip.
  const addTag = page.getByTestId('chip-add-tags');
  await addTag.fill('newtag');
  await addTag.press('Enter');
  await expect(page.getByTestId('chip-tags')).toHaveCount(3);
  await expect
    .poll(() => persisted(page, 'concepts/codemirror.md'))
    .toContain('newtag');

  // Remove the first tag chip (editor).
  await page.getByTestId('chip-remove-tags').first().click();
  await expect(page.getByTestId('chip-tags')).toHaveCount(2);
  await expect
    .poll(async () => {
      const c = await persisted(page, 'concepts/codemirror.md');
      // `editor` removed; `dependency` and `newtag` remain.
      return /tags:\s*\[dependency, newtag\]/.test(c);
    })
    .toBe(true);
});

test('properties panel: the global toggle shows/hides the inline frontmatter', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  await page.locator('[data-path="concepts/codemirror.md"]').click();

  // Hidden by default: no Properties chrome at all (zero height cost).
  await expect(page.getByTestId('properties')).toHaveCount(0);
  await expect(page.getByTestId('scalar-type')).toHaveCount(0);

  // Toggle ON (NavBar): the panel renders its frontmatter inline.
  const toggle = page.getByTestId('properties-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('properties')).toBeVisible();
  await expect(page.getByTestId('scalar-type')).toBeVisible();

  // Toggle OFF again: all Properties chrome disappears (no header, no rows).
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('properties')).toHaveCount(0);
  await expect(page.getByTestId('scalar-type')).toHaveCount(0);
});

test('properties panel: complex frontmatter round-trips byte-for-byte', async ({
  page,
}) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.getByTestId('properties-toggle').click();
  await tree.locator('[data-path="concepts/complex-frontmatter.md"]').click();

  const properties = page.getByTestId('properties');
  await expect(properties).toBeVisible();

  // The complex values render as read-only raw fields.
  const nestedRaw = page.getByTestId('raw-nested');
  const proseRaw = page.getByTestId('raw-prose');
  await expect(nestedRaw).toHaveAttribute('readonly', '');
  await expect(proseRaw).toHaveAttribute('readonly', '');

  // Capture the EXACT complex source blocks from the on-disk fixture before edit.
  const before = await persisted(page, 'concepts/complex-frontmatter.md');
  const nestedBlock =
    'nested:\n  author: jane\n  reviewers:\n    - bob\n    - carol\n';
  const proseBlock =
    'prose: |\n  This is a multi-line\n  block scalar that must\n  be preserved verbatim.\n';
  const customLine = 'custom_field: keep me intact\n';
  const bodyBlock =
    '# Complex Frontmatter\n\nThis Concept has nested and multi-line frontmatter';
  expect(before).toContain(nestedBlock);
  expect(before).toContain(proseBlock);
  expect(before).toContain(customLine);
  expect(before).toContain(bodyBlock);

  // Edit a SIMPLE scalar (title). The complex values + unknown key + body must
  // round-trip byte-for-byte.
  const titleInput = page.getByTestId('scalar-title');
  await titleInput.fill('Edited Complex Title');
  await titleInput.blur();

  await expect
    .poll(() => persisted(page, 'concepts/complex-frontmatter.md'))
    .toContain('title: Edited Complex Title');

  const after = await persisted(page, 'concepts/complex-frontmatter.md');
  expect(after).toContain(nestedBlock); // nested map verbatim
  expect(after).toContain(proseBlock); // multi-line block scalar verbatim
  expect(after).toContain(customLine); // unknown key preserved
  expect(after).toContain(bodyBlock); // body preserved

  // Fill the empty `type` scalar; it persists like any other scalar edit.
  const typeInput = page.getByTestId('scalar-type');
  await typeInput.fill('concept');
  await typeInput.blur();

  // type set persisted, complex still intact.
  const final = await persisted(page, 'concepts/complex-frontmatter.md');
  expect(final).toContain('type: concept');
  expect(final).toContain(nestedBlock);
  expect(final).toContain(proseBlock);

  await page.screenshot({
    path: 'tests/screenshots/frontmatter-panel.png',
    fullPage: true,
  });
});
