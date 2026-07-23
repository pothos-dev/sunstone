import { test, expect, type Page } from '@playwright/test';

/**
 * Slice: tags-multi-expand-keyboard-nav.
 *
 * The Tags Section is a fully keyboard-navigable two-level tree (tag roots →
 * tagged-Concept leaves), and MULTI-expand: several tags stay open at once
 * (matching the Explorer's folders). Drives:
 *  - expanding TWO tags via keyboard and asserting BOTH stay open (the
 *    multi-expand win — expanding one no longer collapses another);
 *  - arrowing across roots + leaves with clamp-at-the-ends, roving tabindex
 *    (exactly one focusable row), descend/jump-to-parent;
 *  - Enter on a concept leaf opens it AND moves focus to the Editor;
 *  - that no CRUD verbs are active in the Tags Region.
 */

/** Expand a collapsible sidebar Section if currently collapsed (idempotent). */
async function expandSection(page: Page, name: string) {
  const header = page.getByTestId(`${name}-section-header`);
  if ((await header.getAttribute('aria-expanded')) === 'false') await header.click();
}

/** The `data-row-key` of the row that currently holds DOM focus. */
async function focusedRow(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return el instanceof HTMLElement ? (el.getAttribute('data-row-key') ?? null) : null;
  });
}

/** Count of rows that are tab-focusable (tabindex=0) — must be exactly one. */
async function rovingCount(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelectorAll('[data-testid="tag-browser"] [tabindex="0"]').length,
  );
}

async function openTags(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  // `editorMode: editing` so a Concept opened from a tag leaf is editable and thus
  // takes focus (read — the default — is not focusable; focus would stay in Tags).
  await page.evaluate(() => window.localStorage.setItem('sunstone:bundleState:/fake/bundle', JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'], editorMode: 'editing' })));
  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();
  await expandSection(page, 'tags');
  await expect(page.getByTestId('tag-browser')).toBeVisible();
}

test('Tags: multi-expand — two tags stay open at once, arrow across roots+leaves, clamp', async ({
  page,
}) => {
  await openTags(page);
  const tb = page.getByTestId('tag-browser');

  // Click the `editor` tag to focus + expand it (2 concepts revealed).
  await tb.locator('[data-tag="editor"]').click();
  await expect.poll(() => focusedRow(page)).toBe('editor');
  await expect(tb.locator('[data-tag="editor"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(tb.getByTestId('tag-concept')).toHaveCount(2);

  // Expand a SECOND tag (`okf`) by clicking it. The MULTI-EXPAND WIN: `editor`
  // must stay open — expanding one no longer collapses another.
  await tb.locator('[data-tag="okf"]').click();
  await expect(tb.locator('[data-tag="okf"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(tb.locator('[data-tag="editor"]')).toHaveAttribute('aria-expanded', 'true');
  // Both tags' concept lists are present simultaneously.
  await expect(tb.getByTestId('tag-concepts')).toHaveCount(2);

  // Roving tabindex invariant: exactly one focusable row.
  await expect.poll(() => rovingCount(page)).toBe(1);

  // Collapse `editor` with ArrowLeft (focus is on it), then re-expand and
  // descend into its first concept leaf with ArrowRight.
  await tb.locator('[data-tag="editor"]').click();
  await expect.poll(() => focusedRow(page)).toBe('editor');
  await page.keyboard.press('ArrowLeft'); // expanded tag → collapse
  await expect(tb.locator('[data-tag="editor"]')).toHaveAttribute('aria-expanded', 'false');
  // `okf` is unaffected — still open (multi-expand).
  await expect(tb.locator('[data-tag="okf"]')).toHaveAttribute('aria-expanded', 'true');

  await page.keyboard.press('ArrowRight'); // collapsed tag → expand
  await expect(tb.locator('[data-tag="editor"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(
    tb.locator('[data-row-key="editor\tconcepts/codemirror.md"]'),
  ).toBeVisible();
  await page.keyboard.press('ArrowRight'); // expanded tag → into first concept leaf
  await expect.poll(() => focusedRow(page)).toBe('editor\tconcepts/codemirror.md');

  // ArrowDown to the next leaf, then ArrowLeft jumps back to the parent tag.
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusedRow(page)).toBe('editor\tconcepts/editor/live-preview.md');
  await page.keyboard.press('ArrowLeft'); // leaf → parent tag
  await expect.poll(() => focusedRow(page)).toBe('editor');

  // Home jumps to the first row; ArrowUp there clamps (no wrap).
  await page.keyboard.press('Home');
  const first = await focusedRow(page);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => focusedRow(page)).toBe(first);

  // End jumps to the last row; ArrowDown there clamps (no wrap).
  await page.keyboard.press('End');
  const last = await focusedRow(page);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusedRow(page)).toBe(last);

  await page.screenshot({ path: 'tests/screenshots/tags-keyboard-nav.png', fullPage: true });
});

test('Tags: Enter on a concept leaf opens it and moves focus to the Editor', async ({ page }) => {
  await openTags(page);
  const tb = page.getByTestId('tag-browser');
  const editor = page.getByTestId('editor');

  // Expand `editor` and descend into its first leaf via the keyboard. Wait for
  // the (async) concept query to fill before ArrowRight, so there is a leaf to
  // descend into.
  await tb.locator('[data-tag="editor"]').click();
  await expect.poll(() => focusedRow(page)).toBe('editor');
  await expect(tb.getByTestId('tag-concept')).toHaveCount(2);
  await page.keyboard.press('ArrowRight'); // expanded → into first leaf
  await expect.poll(() => focusedRow(page)).toBe('editor\tconcepts/codemirror.md');

  // Enter opens the Concept AND moves focus to the Editor (out of the Tags tree).
  await page.keyboard.press('Enter');
  await expect(editor).toContainText('CodeMirror 6 is the editor core');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const el = document.activeElement;
        return !!el && !!el.closest('.cm-editor');
      }),
    )
    .toBe(true);
});

test('Tags: no CRUD verbs are active (d/a/r/m do nothing)', async ({ page }) => {
  await openTags(page);
  const tb = page.getByTestId('tag-browser');

  // Focus a concept leaf.
  await tb.locator('[data-tag="editor"]').click();
  await expect(tb.getByTestId('tag-concept')).toHaveCount(2);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => focusedRow(page)).toBe('editor\tconcepts/codemirror.md');
  const conceptCountBefore = await tb.getByTestId('tag-concept').count();

  // CRUD letters must be inert in the Tags Region: no dialog appears, the
  // Focused item is unchanged, and the concept list is unchanged.
  for (const key of ['d', 'a', 'r', 'm']) {
    await page.keyboard.press(key);
  }
  // No TreeCrud dialog opened (it lives in the Explorer, keyed by its own role).
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => focusedRow(page)).toBe('editor\tconcepts/codemirror.md');
  await expect(tb.getByTestId('tag-concept')).toHaveCount(conceptCountBefore);
});
