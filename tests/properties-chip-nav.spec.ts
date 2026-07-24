import { test, expect, type Page } from '@playwright/test';

/**
 * Slice: properties-chip-subnavigation.
 *
 * A list/chip VALUE cell now has THREE focus depths (docs/GLOSSARY.md "Focused item"):
 *   1. grid nav   — the value cell wrapper is the Focused item (properties-grid-nav),
 *   2. chip sub-nav — Enter drops in onto the first chip; ←/→ move across the strip
 *      `[chip]…[+ new-tag input]` (↑/↓ inert); `d` deletes the focused chip (focus →
 *      neighbour); Enter on a chip does nothing; Enter on the new-tag input → text edit,
 *   3. text edit  — typing in the new-tag input; Enter commits a chip.
 * Escape peels EXACTLY one layer per press: text-edit → chip sub-nav → grid nav.
 */

/** Read the persisted raw markdown of a Concept from the fake backend. */
function persisted(page: Page, path: string): Promise<string> {
  return page.evaluate(
    (p) =>
      (window as unknown as { __sunstoneFake: { files: Record<string, string> } })
        .__sunstoneFake.files[p],
    path,
  );
}

/** `{row,col}` of the active element when it is a grid cell wrapper, else null. */
async function activeCell(page: Page): Promise<{ row: number; col: number } | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || !el.classList.contains('cell')) return null;
    return { row: Number(el.dataset.cellRow), col: Number(el.dataset.cellCol) };
  });
}

/** data-testid of the active element, if any. */
async function activeTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
}

/** The chip index (data-chip-index) of the active element, or null if not a chip. */
async function activeChipIndex(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || el.dataset.chipIndex === undefined) return null;
    return Number(el.dataset.chipIndex);
  });
}

/** The text of the chips in the `tags` list cell, in order. */
function chipTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="chip-tags"]')).map((c) =>
      (c.textContent ?? '').replace(/×\s*$/, '').trim(),
    ),
  );
}

async function openCodemirror(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  await page.evaluate(() => window.localStorage.setItem('sunstone:bundleState:/fake/bundle', JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'], propertiesShown: true })));
  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();
  await page.getByTestId('tree').locator('[data-path="concepts/codemirror.md"]').click();
  await expect(page.getByTestId('properties')).toBeVisible();
  // codemirror.md frontmatter rows: 0 type | 1 title | 2 description | 3 tags(list) | 4 timestamp
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('CodeMirror 6 is the editor core');
  // Read is the default; enter editing so the Editor takes click focus (the grid
  // nav below moves in from an editor-focused baseline).
  await page.getByTestId('edit-toggle').click();
  await editor.locator('.cm-content').click();
  return editor;
}

/** Move the grid cursor to the `tags` VALUE cell (row 3, col 1) in nav mode. */
async function focusTagsValueCell(page: Page) {
  await page.keyboard.press('Alt+ArrowUp'); // into Properties, nav mode, row 0 key
  await expect.poll(() => activeCell(page)).toEqual({ row: 0, col: 0 });
  await page.keyboard.press('ArrowRight'); // row 0 value
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown'); // to row 3 value
  await expect.poll(() => activeCell(page)).toEqual({ row: 3, col: 1 });
}

test('chip sub-nav: Enter into the strip, arrow across, delete with `d`, add via input, Escape peels one layer', async ({
  page,
}) => {
  await openCodemirror(page);
  await focusTagsValueCell(page);

  const before = await chipTexts(page);
  expect(before.length).toBeGreaterThanOrEqual(2);

  // 1. Enter drops into chip sub-nav on the FIRST chip.
  await page.keyboard.press('Enter');
  await expect.poll(() => activeChipIndex(page)).toBe(0);

  // ←/→ move focus across the chips and onto the new-tag input; ↑/↓ are inert.
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => activeChipIndex(page)).toBe(1);
  await page.keyboard.press('ArrowUp'); // inert
  await expect.poll(() => activeChipIndex(page)).toBe(1);
  await page.keyboard.press('ArrowDown'); // inert
  await expect.poll(() => activeChipIndex(page)).toBe(1);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => activeChipIndex(page)).toBe(0);

  // Right past the last chip lands on the new-tag input (chip index null).
  for (let i = 0; i < before.length; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(() => activeTestId(page)).toBe('chip-add-tags');
  await expect.poll(() => activeChipIndex(page)).toBeNull();

  // Back to the first chip; Enter on a chip does NOTHING (no edit, no delete).
  await page.keyboard.press('Home'); // a no-op key for the strip; stay put-ish
  for (let i = 0; i < before.length; i++) await page.keyboard.press('ArrowLeft');
  await expect.poll(() => activeChipIndex(page)).toBe(0);
  await page.keyboard.press('Enter');
  await expect.poll(() => activeChipIndex(page)).toBe(0); // still on the chip
  expect(await chipTexts(page)).toEqual(before); // unchanged

  // 2. `d` deletes the focused chip; focus moves to a neighbour chip.
  await page.keyboard.press('d');
  await expect.poll(() => chipTexts(page)).toEqual(before.slice(1));
  await expect.poll(() => activeChipIndex(page)).toBe(0); // neighbour (the slot index)

  // 3. Arrow to the new-tag input, Enter → text edit, type + Enter commits a chip.
  const remaining = await chipTexts(page);
  for (let i = 0; i < remaining.length; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(() => activeTestId(page)).toBe('chip-add-tags');
  await page.keyboard.press('Enter'); // enter text edit on the input
  await page.keyboard.type('freshtag');
  await page.keyboard.press('Enter'); // commit the chip
  await expect.poll(() => chipTexts(page)).toEqual([...remaining, 'freshtag']);
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain('freshtag');

  await page.screenshot({ path: 'tests/screenshots/properties-chip-nav.png', fullPage: true });

  // 4. Escape peels EXACTLY one layer per press: text-edit → chip sub-nav → grid nav.
  // We're in text edit (after committing, still in the input typing). Type a draft,
  // then Escape abandons it and peels to chip sub-nav (focus stays on the input).
  await page.keyboard.type('discard-me');
  await page.keyboard.press('Escape'); // text-edit → chip sub-nav
  await expect.poll(() => activeTestId(page)).toBe('chip-add-tags');
  await expect.poll(() => activeChipIndex(page)).toBeNull(); // still on the new-tag input slot
  // The abandoned draft was NOT committed.
  expect(await chipTexts(page)).not.toContain('discard-me');

  await page.keyboard.press('Escape'); // chip sub-nav → grid nav (value cell)
  await expect.poll(() => activeCell(page)).toEqual({ row: 3, col: 1 });

  await page.keyboard.press('Escape'); // grid nav → Editor (Region peel)
  await expect
    .poll(() => page.evaluate(() => document.querySelector('.region-active')?.getAttribute('data-region')))
    .toBe('editor');
});

test('chip sub-nav on an empty list lands on the new-tag input', async ({ page }) => {
  await openCodemirror(page);
  await focusTagsValueCell(page);

  // Delete every chip first (enter sub-nav, delete until empty).
  await page.keyboard.press('Enter');
  let n = (await chipTexts(page)).length;
  while (n > 0) {
    await expect.poll(() => activeChipIndex(page)).not.toBeNull();
    await page.keyboard.press('d');
    n -= 1;
  }
  expect(await chipTexts(page)).toEqual([]);
  // With no chips, focus is on the new-tag input (the only strip slot).
  await expect.poll(() => activeTestId(page)).toBe('chip-add-tags');

  // Escape from here peels straight back to grid nav (one layer, no chips between).
  await page.keyboard.press('Escape');
  await expect.poll(() => activeCell(page)).toEqual({ row: 3, col: 1 });
});
