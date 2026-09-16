import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';

/**
 * Ticket 02a: edit Frontmatter as YAML (ADR 0008, superseding ADR 0003's
 * Properties panel).
 *
 * Drives the Frontmatter Region against the fake backend:
 *  - collapsed by default; the toggle shows the block with `---` fences as
 *    Region chrome and the inner YAML in its own editor,
 *  - read mode shows the SAME text, verbatim and not editable,
 *  - a NESTED value (what the old panel rendered read-only) is authorable,
 *  - a body-only edit leaves the block byte-for-byte,
 *  - the SAVE GATE: a block that does not parse holds the write, shows the error
 *    indicator and the Save button, and an explicit Save forces it through,
 *  - clearing the block removes the `---` fences entirely,
 *  - Format is explicit and never runs on save.
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

/**
 * Put the cursor at the END of line `n` (0-based) of the YAML editor. Keyboard
 * navigation rather than `getByText`, which is unstable once highlighting loads
 * and splits a line across spans.
 */
async function toYamlLine(page: Page, n: number) {
  const yaml = page.getByTestId('frontmatter').locator('.cm-content');
  await yaml.click();
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < n; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
}

/** Open a Concept with the Frontmatter Region shown and editing on. */
async function openForEditing(page: Page, path: string) {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await tree.locator(`[data-path="${path}"]`).click();
  await page.getByTestId('frontmatter-toggle').click();
  await page.getByTestId('edit-toggle').click();
  const yaml = page.getByTestId('frontmatter').locator('.cm-content');
  await expect(yaml).toHaveAttribute('contenteditable', 'true');
  return yaml;
}

test('frontmatter: collapsed by default; the toggle shows the fences + inner YAML', async ({
  page,
}) => {
  // Track script loads, to pin the "nothing extra loads while collapsed" half of
  // the contract: the YAML grammar + linter are behind a dynamic import.
  const scripts: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('.js')) scripts.push(r.url());
  });

  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  await page.locator('[data-path="concepts/codemirror.md"]').click();

  // Collapsed by default: no Frontmatter chrome at all (zero height cost).
  await expect(page.getByTestId('frontmatter')).toHaveCount(0);
  const beforeExpand = scripts.length;

  const toggle = page.getByTestId('frontmatter-toggle');
  await toggle.click();
  // Expanding fetches the language chunk that the collapsed Region never did.
  await expect.poll(() => scripts.length).toBeGreaterThan(beforeExpand);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  const region = page.getByTestId('frontmatter');
  await expect(region).toBeVisible();
  // The `---` delimiters are Region CHROME; the editor holds the inner block.
  await expect(page.getByTestId('frontmatter-fence-open')).toHaveText('---');
  await expect(page.getByTestId('frontmatter-fence-close')).toHaveText('---');
  const yaml = region.locator('.cm-content');
  await expect(yaml).toContainText('type: concept');
  await expect(yaml).toContainText('tags: [editor, dependency]');
  await expect(yaml).not.toContainText('---');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('frontmatter')).toHaveCount(0);
});

test('frontmatter: a Concept with no block shows an empty editor; it materialises on save', async ({
  page,
}) => {
  const yaml = await openForEditing(page, 'concepts/no-frontmatter.md');
  await expect(yaml).toHaveText('');
  // The fences are still drawn as Region chrome — the block is simply empty.
  await expect(page.getByTestId('frontmatter-fence-open')).toHaveText('---');

  await yaml.click();
  await page.keyboard.type('type: concept');

  await expect
    .poll(() => persisted(page, 'concepts/no-frontmatter.md'))
    .toContain('---\ntype: concept\n---\n');
  expect(await persisted(page, 'concepts/no-frontmatter.md')).toContain('# No Frontmatter');
});

test('frontmatter: read mode shows the same YAML verbatim, not editable', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  await page.locator('[data-path="concepts/complex-frontmatter.md"]').click();
  await page.getByTestId('frontmatter-toggle').click();

  // Read is the default mode: the YAML renders, un-reformatted, read-only.
  const yaml = page.getByTestId('frontmatter').locator('.cm-content');
  await expect(yaml).toHaveAttribute('contenteditable', 'false');
  // Verbatim: the block scalar and the nested map read exactly as on disk.
  await expect(yaml).toContainText('prose: |');
  await expect(yaml).toContainText('author: jane');
  // Read mode offers no Format control (nothing here can change the file).
  await expect(page.getByTestId('frontmatter-format')).toHaveCount(0);
});

test('frontmatter: a NESTED value is authorable and the rest round-trips verbatim', async ({
  page,
}) => {
  const yaml = await openForEditing(page, 'concepts/complex-frontmatter.md');

  const before = await persisted(page, 'concepts/complex-frontmatter.md');
  const proseBlock =
    'prose: |\n  This is a multi-line\n  block scalar that must\n  be preserved verbatim.\n';
  const customLine = 'custom_field: keep me intact\n';
  expect(before).toContain('  author: jane\n');
  expect(before).toContain(proseBlock);
  expect(before).toContain(customLine);

  // Edit a value INSIDE the nested map — the exact thing the structured panel
  // rendered read-only (ADR 0008's reason for existing). `nested:` is line 5 of
  // the block, `  author: jane` line 6.
  void yaml;
  await toYamlLine(page, 6);
  for (const _ of 'jane') await page.keyboard.press('Backspace');
  await page.keyboard.type('morgan');

  await expect
    .poll(() => persisted(page, 'concepts/complex-frontmatter.md'))
    .toContain('  author: morgan\n');

  const after = await persisted(page, 'concepts/complex-frontmatter.md');
  expect(after).toContain('    - bob\n    - carol\n'); // sibling list untouched
  expect(after).toContain(proseBlock); // block scalar verbatim
  expect(after).toContain(customLine); // unknown key preserved
  expect(after).toContain('# Complex Frontmatter'); // body preserved
});

test('frontmatter: a body-only edit leaves the block byte-for-byte', async ({ page }) => {
  await openForEditing(page, 'concepts/complex-frontmatter.md');

  const before = await persisted(page, 'concepts/complex-frontmatter.md');
  const block = before.slice(0, before.indexOf('\n---\n') + '\n---\n'.length);
  expect(block.startsWith('---\n')).toBe(true);

  // Type in the BODY only.
  const body = page.getByTestId('editor').locator('.cm-content');
  await body.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\nBODY_ONLY_MARKER');

  await expect
    .poll(() => persisted(page, 'concepts/complex-frontmatter.md'))
    .toContain('BODY_ONLY_MARKER');

  const after = await persisted(page, 'concepts/complex-frontmatter.md');
  // Byte-for-byte: comments, quoting, key order, flow style, the empty `type`.
  expect(after.slice(0, block.length)).toBe(block);
});

test('frontmatter: the save gate holds an unparseable block, Save forces it through', async ({
  page,
}) => {
  const yaml = await openForEditing(page, 'concepts/codemirror.md');

  // Break the YAML: drop the closing `]` of the `tags` flow sequence (line 3).
  void yaml;
  await toYamlLine(page, 3);
  await page.keyboard.press('Backspace');

  // The indicator appears (debounced ~1s so it never flashes while typing) and
  // the Save button shows even on desktop — a held write must be visible.
  await expect(page.getByTestId('frontmatter-error')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('save-concept')).toBeVisible();

  // Nothing is written while the block does not parse — body edits are held with
  // it, because the write is whole-file.
  const body = page.getByTestId('editor').locator('.cm-content');
  await body.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\nHELD_BODY_EDIT');
  await page.waitForTimeout(600);
  expect(await persisted(page, 'concepts/codemirror.md')).not.toContain('HELD_BODY_EDIT');
  expect(await persisted(page, 'concepts/codemirror.md')).toContain(
    'tags: [editor, dependency]',
  );

  // The EXPLICIT save writes regardless: losing the author's text is worse than
  // a momentarily broken file.
  await page.getByTestId('save-concept').click();
  await expect
    .poll(() => persisted(page, 'concepts/codemirror.md'))
    .toContain('HELD_BODY_EDIT');
  expect(await persisted(page, 'concepts/codemirror.md')).toContain(
    'tags: [editor, dependency',
  );
});

test('frontmatter: clearing the block removes the `---` fences', async ({ page }) => {
  const yaml = await openForEditing(page, 'concepts/codemirror.md');

  await yaml.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+Shift+End');
  await page.keyboard.press('Backspace');
  await expect(yaml).toHaveText('');

  await expect
    .poll(async () => (await persisted(page, 'concepts/codemirror.md')).startsWith('---'))
    .toBe(false);
  const after = await persisted(page, 'concepts/codemirror.md');
  expect(after).not.toContain('type: concept');
  expect(after).toContain('# CodeMirror'); // the body survives
});

test('frontmatter: Format is explicit — nothing reflows on save', async ({ page }) => {
  const yaml = await openForEditing(page, 'concepts/codemirror.md');

  // Introduce sloppy spacing and let the autosave land: it persists AS TYPED.
  void yaml;
  await toYamlLine(page, 1); // `title: CodeMirror`
  await page.keyboard.press('Shift+Home');
  await page.keyboard.type('title:    CodeMirror');

  await expect
    .poll(() => persisted(page, 'concepts/codemirror.md'))
    .toContain('title:    CodeMirror');

  // The explicit command reflows it (and keeps everything else).
  await page.getByTestId('frontmatter-format').click();
  await expect
    .poll(() => persisted(page, 'concepts/codemirror.md'))
    .toContain('title: CodeMirror');
  expect(await persisted(page, 'concepts/codemirror.md')).toContain('type: concept');

  await page.screenshot({
    path: 'tests/screenshots/frontmatter-editor.png',
    fullPage: true,
  });
});
