import { test, expect, type Page } from '@playwright/test';

/**
 * Slice: escape-peel-restore-opener.
 *
 * The unified `Escape` model + overlay focus-return, layering over the basic
 * Region→Editor peel:
 *   Escape peels EXACTLY ONE layer per press, innermost first —
 *     1. in-field edit (Properties draft / chip text-edit) → cancel locally, STAY,
 *     2. overlay open (QuickNav, Search, context menu, TreeCrud dialog) → close it,
 *     3. non-Editor Region focused → home to the Editor,
 *     4. Editor focused / nothing open → no-op.
 *   Overlay focus-return splits by OUTCOME:
 *     - CANCEL (Escape / backdrop) → restore focus to the OPENER Region (and its
 *       remembered Focused item),
 *     - COMMIT (Enter / click a result) → focus FOLLOWS the action (Concept→Editor,
 *       CRUD→Explorer row).
 *   A peeked Region survives an overlay open+cancel round-trip.
 */

/** The id of the Region currently showing the active-Region affordance. */
async function activeRegion(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector('.region-active[data-region]');
    return el ? el.getAttribute('data-region') : null;
  });
}

async function expectActive(page: Page, id: string) {
  await expect.poll(() => activeRegion(page)).toBe(id);
}

/** The bundle-relative path of the row that currently holds DOM focus. */
async function focusedRow(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return el instanceof HTMLElement ? (el.getAttribute('data-row-path') ?? null) : null;
  });
}

/** Whether DOM focus is currently inside the CodeMirror editor. */
async function focusInEditor(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const cm = document.querySelector('[data-region="editor"]');
    return cm?.contains(document.activeElement) ?? false;
  });
}

async function altPress(page: Page, key: string) {
  await page.keyboard.press(`Alt+${key}`);
}

async function freshLoad(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  await page.evaluate(() => window.localStorage.setItem('sunstone:bundleState:/fake/bundle', JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'], propertiesShown: true })));
  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();
}

/** Click a tree file row to make it the Explorer's Focused item (keyboard cursor). */
async function focusFileRow(page: Page, path: string) {
  await page.getByTestId('tree').locator(`.row[data-row-path="${path}"]`).click();
  await expect.poll(() => focusedRow(page)).toBe(path);
}

test('QuickNav from the Explorer: cancel restores the opener row; commit follows to the Editor', async ({
  page,
}) => {
  await freshLoad(page);

  // Make a specific Explorer row the Focused item (the opener).
  await focusFileRow(page, 'concepts/codemirror.md');
  await expectActive(page, 'explorer');

  // Open QuickNav (Ctrl+K). Focus moves into the overlay (outside every Region).
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('quick-nav')).toBeVisible();

  // CANCEL (Escape) → the overlay closes and focus is RESTORED to the opener
  // Explorer row, exactly where it left.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('quick-nav')).toHaveCount(0);
  await expectActive(page, 'explorer');
  await expect.poll(() => focusedRow(page)).toBe('concepts/codemirror.md');

  await page.screenshot({ path: 'tests/screenshots/escape-peel.png', fullPage: true });

  // Read is the default; enter editing so the committed Concept below is editable
  // and focus can FOLLOW into the Editor (a read-only view is not focusable). The
  // codemirror Concept opened above (via focusFileRow) makes the toggle available.
  await page.getByTestId('edit-toggle').click();

  // Re-open and COMMIT a result → focus FOLLOWS the action into the Editor.
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('quick-nav');
  await expect(palette).toBeVisible();
  await page.getByTestId('quick-nav-input').fill('bundle');
  await expect(palette.locator('[data-path="concepts/bundle.md"]')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('quick-nav')).toHaveCount(0);
  await expect(page.getByTestId('editor')).toContainText('is the root folder');
  await expect.poll(() => focusInEditor(page)).toBe(true);
  await expectActive(page, 'editor');
});

test('backdrop click cancels QuickNav and restores the opener Region', async ({ page }) => {
  await freshLoad(page);
  await focusFileRow(page, 'concepts/codemirror.md');

  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('quick-nav')).toBeVisible();

  // Clicking the backdrop is the OTHER cancel path; it must also restore the opener.
  await page.locator('.qn-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('quick-nav')).toHaveCount(0);
  await expectActive(page, 'explorer');
  await expect.poll(() => focusedRow(page)).toBe('concepts/codemirror.md');
});

test('Search from the Explorer: cancel restores the opener row', async ({ page }) => {
  await freshLoad(page);
  await focusFileRow(page, 'concepts/codemirror.md');

  // Open Search (Ctrl+Shift+F).
  await page.keyboard.press('Control+Shift+f');
  await expect(page.getByTestId('search-panel')).toBeVisible();

  // CANCEL (Escape) restores focus to the opener Explorer row.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('search-panel')).toHaveCount(0);
  await expectActive(page, 'explorer');
  await expect.poll(() => focusedRow(page)).toBe('concepts/codemirror.md');
});

test('Properties: Escape peels EXACTLY one layer per press (chip text-edit → chip sub-nav → grid nav → Editor)', async ({
  page,
}) => {
  await freshLoad(page);
  // codemirror.md has a `tags` list value cell (row 3, col 1).
  await page.getByTestId('tree').locator('[data-path="concepts/codemirror.md"]').click();
  await expect(page.getByTestId('properties')).toBeVisible();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('CodeMirror 6 is the editor core');
  // Read is the default; enter editing so the Editor takes click focus.
  await page.getByTestId('edit-toggle').click();
  await editor.locator('.cm-content').click();
  await expectActive(page, 'editor');

  // Move the grid cursor into Properties and onto the `tags` value cell.
  await page.keyboard.press('Alt+ArrowUp'); // Properties, nav mode, row 0 key
  await page.keyboard.press('ArrowRight'); // row 0 value
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown'); // row 3 value
  await expect
    .poll(() =>
      page.evaluate(() => {
        const el = document.activeElement;
        return el instanceof HTMLElement && el.classList.contains('cell')
          ? { row: Number(el.dataset.cellRow), col: Number(el.dataset.cellCol) }
          : null;
      }),
    )
    .toEqual({ row: 3, col: 1 });

  // Enter chip sub-nav, arrow to the new-tag input, Enter → text edit, type a draft.
  await page.keyboard.press('Enter'); // → chip sub-nav (first chip)
  const chipCount = await page.locator('[data-testid="chip-tags"]').count();
  for (let i = 0; i < chipCount; i++) await page.keyboard.press('ArrowRight'); // → new-tag input
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
    'chip-add-tags',
  );
  await page.keyboard.press('Enter'); // → text edit
  await page.keyboard.type('peel-draft');

  // LAYER 1 (in-field edit): Escape abandons the draft, STAYS in the strip (chip
  // sub-nav). Does NOT bubble to the overlay/Region peel.
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
    'chip-add-tags',
  );
  const chips = await page
    .locator('[data-testid="chip-tags"]')
    .evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/×\s*$/, '').trim()));
  expect(chips).not.toContain('peel-draft');

  // LAYER 1 again (chip sub-nav → grid nav): one more layer, still in Properties.
  await page.keyboard.press('Escape');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const el = document.activeElement;
        return el instanceof HTMLElement && el.classList.contains('cell')
          ? { row: Number(el.dataset.cellRow), col: Number(el.dataset.cellCol) }
          : null;
      }),
    )
    .toEqual({ row: 3, col: 1 });
  await expectActive(page, 'properties');

  // LAYER 3 (non-Editor Region → Editor): now in grid nav, Escape homes to Editor.
  await page.keyboard.press('Escape');
  await expectActive(page, 'editor');

  // LAYER 4 (Editor, nothing open): a final Escape is a no-op (stays in Editor).
  await page.keyboard.press('Escape');
  await expectActive(page, 'editor');
});

test('a peeked Region survives an overlay open+cancel and focus returns into the peek', async ({
  page,
}) => {
  await freshLoad(page);
  await page.getByTestId('tree').locator('[data-path="concepts/codemirror.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('CodeMirror 6 is the editor core');
  // Read is the default; enter editing so the Editor takes click focus.
  await page.getByTestId('edit-toggle').click();
  await editor.locator('.cm-content').click();
  await expectActive(page, 'editor');

  // The right Sidebar starts collapsed; Alt+Right transiently REVEALS it and
  // lands focus in Backlinks (the peeked Region = the overlay's opener).
  await expect(page.getByTestId('right-side-bar')).toHaveClass(/collapsed/);
  await altPress(page, 'ArrowRight');
  await expectActive(page, 'backlinks');
  await expect(page.getByTestId('right-side-bar')).not.toHaveClass(/collapsed/);

  // Open + CANCEL QuickNav: the peek must survive AND focus return into Backlinks.
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('quick-nav')).toBeVisible();
  await expect(page.getByTestId('right-side-bar')).not.toHaveClass(/collapsed/);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('quick-nav')).toHaveCount(0);
  await expect(page.getByTestId('right-side-bar')).not.toHaveClass(/collapsed/);
  await expectActive(page, 'backlinks');
});

test('TreeCrud rename dialog closes on Escape and restores focus to the Explorer row', async ({
  page,
}) => {
  await freshLoad(page);

  // Make a row the Focused item, then open the rename dialog via the `r` keybinding.
  await focusFileRow(page, 'concepts/codemirror.md');
  await page.keyboard.press('r');
  await expect(page.getByTestId('tree-dialog')).toContainText('Rename');

  // The dialog is an OVERLAY: Escape closes it (it had no Escape-to-close before
  // this slice — only Cancel/backdrop) and restores focus to the Explorer row.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tree-dialog')).toHaveCount(0);
  await expectActive(page, 'explorer');
  await expect.poll(() => focusedRow(page)).toBe('concepts/codemirror.md');
});
