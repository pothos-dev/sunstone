import { test, expect, type Page } from '@playwright/test';

/**
 * Slice: properties-grid-navigation.
 *
 * The Properties Section is a spreadsheet-style 2-column grid (key | value) with
 * two modes (docs/GLOSSARY.md "Focused item"; ADR 0003):
 *   - NAV mode  — the cell WRAPPER holds focus (spotlight ring); arrows navigate
 *                 (clamp at edges), the inner <input> is NOT focused.
 *   - EDIT mode — the cell's <input> is focused; ordinary text editing.
 *
 * Drives the grid:
 *  - Alt+↑ from the Editor lands on the remembered cell in NAV mode,
 *  - arrows move row/column with clamp, input not focused,
 *  - Enter/F2 enter edit mode; Enter commits + moves down; Tab commits + moves
 *    right; Escape cancels to nav,
 *  - `a` adds a row in edit mode on its key cell; `d` deletes the focused row,
 *  - Ctrl+C/Ctrl+V work in both nav mode (whole cell value) and edit mode (native),
 *  - read-only raw-YAML cells are navigable but not editable.
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

/** Whether the active element is an <input>/<textarea> (i.e. edit mode). */
async function activeIsInput(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  });
}

/** data-testid of the active element, if any. */
async function activeTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
}

/** The id of the Region currently showing the active-Region affordance. */
async function activeRegion(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector('.region-active[data-region]');
    return el ? el.getAttribute('data-region') : null;
  });
}

async function openCodemirror(page: Page) {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.evaluate(() => window.localStorage.setItem('sunstone:bundleState:/fake/bundle', JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'], propertiesShown: true })));
  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();
  await page.getByTestId('tree').locator('[data-path="concepts/codemirror.md"]').click();
  await expect(page.getByTestId('properties')).toBeVisible();
  // codemirror.md frontmatter rows (document order):
  //   0 type | 1 title | 2 description | 3 tags(list) | 4 timestamp
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('CodeMirror 6 is the editor core');
  // Read is the default; enter editing so the Editor takes click focus (the grid
  // nav below moves in from an editor-focused baseline).
  await page.getByTestId('edit-toggle').click();
  await editor.locator('.cm-content').click();
  await expect.poll(() => activeRegion(page)).toBe('editor');
  return editor;
}

test('grid nav: Alt+↑ enters nav mode, arrows move + clamp, input not focused', async ({
  page,
}) => {
  await openCodemirror(page);

  // Alt+↑ from the Editor lands in the Properties Region in NAV mode on the
  // remembered cell (default: row-0 key cell).
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page.locator('.region-active[data-region="properties"]')).toBeVisible();
  await expect.poll(() => activeCell(page)).toEqual({ row: 0, col: 0 });
  expect(await activeIsInput(page)).toBe(false); // nav mode: the input is NOT focused

  // ArrowUp clamps at the top row (no wrap).
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => activeCell(page)).toEqual({ row: 0, col: 0 });

  // ArrowRight → value column; ArrowDown moves rows.
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => activeCell(page)).toEqual({ row: 0, col: 1 });
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => activeCell(page)).toEqual({ row: 1, col: 1 });

  // ArrowLeft → key column (clamp).
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => activeCell(page)).toEqual({ row: 1, col: 0 });
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => activeCell(page)).toEqual({ row: 1, col: 0 });

  // ArrowDown walks to the last DATA row (4 = timestamp)…
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown'); // rows 2, 3, 4
  await expect.poll(() => activeCell(page)).toEqual({ row: 4, col: 0 });
  // …then ONTO the add-controls row (the "+ Text" / "+ List" buttons), which is
  // a navigable grid row one past the last data row. It is a button, not a cell
  // wrapper, so `activeCell` is null; identify it by testid.
  await page.keyboard.press('ArrowDown'); // → "+ Text"
  await expect.poll(() => activeCell(page)).toBeNull();
  await expect.poll(() => activeTestId(page)).toBe('add-text');
  await page.keyboard.press('ArrowDown'); // clamps on the add-controls row
  await expect.poll(() => activeTestId(page)).toBe('add-text');
  // ←/→ move between the two add buttons.
  await page.keyboard.press('ArrowRight'); // → "+ List"
  await expect.poll(() => activeTestId(page)).toBe('add-list');
  // ↑ returns to the last data row (value column, since we're on col 1).
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => activeCell(page)).toEqual({ row: 4, col: 1 });

  await page.screenshot({ path: 'tests/screenshots/properties-grid-nav.png', fullPage: true });
});

test('grid edit: Enter edits + commits + moves down; Tab commits + moves right; Escape cancels', async ({
  page,
}) => {
  await openCodemirror(page);
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => activeCell(page)).toEqual({ row: 0, col: 0 });

  // Navigate to the title VALUE cell (row 1, col 1) and Enter → edit mode.
  await page.keyboard.press('ArrowDown'); // row 1 key
  await page.keyboard.press('ArrowRight'); // row 1 value
  await page.keyboard.press('Enter');
  expect(await activeIsInput(page)).toBe(true);
  await expect.poll(() => activeTestId(page)).toBe('scalar-title');

  // Replace the value and commit with Enter → back to nav mode, move DOWN.
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Edited By Enter');
  await page.keyboard.press('Enter');
  expect(await activeIsInput(page)).toBe(false);
  await expect.poll(() => activeCell(page)).toEqual({ row: 2, col: 1 }); // moved down
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain(
    'title: Edited By Enter',
  );

  // Edit description (now focused) and commit with Tab → move RIGHT/next: a value
  // cell Tabs to the NEXT row's key cell (row 3 key = tags).
  await page.keyboard.press('Enter'); // enter edit on description value
  await expect.poll(() => activeTestId(page)).toBe('scalar-description');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Edited By Tab');
  await page.keyboard.press('Tab');
  expect(await activeIsInput(page)).toBe(false);
  await expect.poll(() => activeCell(page)).toEqual({ row: 3, col: 0 }); // next row's key
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain(
    'description: Edited By Tab',
  );

  // F2 also enters edit mode; Escape cancels the draft and returns to the SAME
  // cell in nav mode. Go to a scalar value cell first (row 4 = timestamp value).
  await page.keyboard.press('ArrowDown'); // row 4 key
  await page.keyboard.press('ArrowRight'); // row 4 value
  await page.keyboard.press('F2');
  expect(await activeIsInput(page)).toBe(true);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('SHOULD_NOT_PERSIST');
  await page.keyboard.press('Escape');
  expect(await activeIsInput(page)).toBe(false);
  await expect.poll(() => activeCell(page)).toEqual({ row: 4, col: 1 }); // same cell
  expect(await persisted(page, 'concepts/codemirror.md')).not.toContain('SHOULD_NOT_PERSIST');
});

test('grid: `a` adds a row in edit mode on its key cell; `d` deletes the focused row', async ({
  page,
}) => {
  await openCodemirror(page);
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => activeCell(page)).toEqual({ row: 0, col: 0 });

  const rowCount = () => page.locator('.properties .row').count();
  const before = await rowCount();

  // `a` appends a new row and drops into edit mode on its (empty) key cell.
  await page.keyboard.press('a');
  await expect.poll(rowCount).toBe(before + 1);
  expect(await activeIsInput(page)).toBe(true);
  await expect.poll(() => activeCell(page)).toBeNull(); // an input, not a wrapper

  // Name the new key + commit; the row persists.
  await page.keyboard.type('priority');
  await page.keyboard.press('Enter');
  await expect.poll(rowCount).toBe(before + 1);

  // Navigate to the new row (last, row index = before) and delete it with `d`.
  await page.keyboard.press('Alt+ArrowUp'); // re-assert nav mode in Properties
  await expect.poll(() => activeCell(page)).not.toBeNull();
  // Overshoot down onto the add-controls row, then step back UP one to land on
  // the last data row (the new `priority` row, index `before`).
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => activeCell(page)).toEqual({ row: before, col: 0 });
  await page.keyboard.press('d');
  await expect.poll(rowCount).toBe(before);
});

test('grid clipboard: Ctrl+C/Ctrl+V in nav mode (whole cell) and edit mode (native)', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openCodemirror(page);
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => activeCell(page)).toEqual({ row: 0, col: 0 });

  // NAV-mode copy: focus the title VALUE cell (row 1, col 1) and Ctrl+C copies
  // the whole cell value ("CodeMirror") to the clipboard.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => activeCell(page)).toEqual({ row: 1, col: 1 });
  await page.keyboard.press('Control+c');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('CodeMirror');

  // NAV-mode paste: move to the description VALUE cell and Ctrl+V pastes the
  // copied string in as the whole cell value.
  await page.keyboard.press('ArrowDown'); // row 2 value (description)
  await expect.poll(() => activeCell(page)).toEqual({ row: 2, col: 1 });
  await page.keyboard.press('Control+v');
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain(
    'description: CodeMirror',
  );

  // EDIT-mode copy/paste is native: enter edit mode, select all, copy, then
  // append the pasted text — the input ends up with doubled content.
  await page.keyboard.press('Enter'); // edit description (now "CodeMirror")
  expect(await activeIsInput(page)).toBe(true);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c'); // native copy of the selection
  await page.keyboard.press('End');
  await page.keyboard.press('Control+v'); // native paste appends
  await page.keyboard.press('Enter'); // commit
  await expect.poll(() => persisted(page, 'concepts/codemirror.md')).toContain(
    'description: CodeMirrorCodeMirror',
  );
});

test('grid: read-only raw-YAML cells are navigable but not editable', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  await page.evaluate(() => window.localStorage.setItem('sunstone:bundleState:/fake/bundle', JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'], propertiesShown: true })));
  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();
  await page
    .getByTestId('tree')
    .locator('[data-path="concepts/complex-frontmatter.md"]')
    .click();
  await expect(page.getByTestId('properties')).toBeVisible();
  // complex-frontmatter.md rows (document order): 0 type, 1 title,
  // 2 description, 3 tags, 4 custom_field, 5 nested(raw), 6 prose(raw). The two
  // complex cells (nested, prose) render as read-only textareas.
  await expect(page.getByTestId('raw-nested')).toHaveAttribute('readonly', '');

  const editor = page.getByTestId('editor');
  // Read is the default; enter editing so the Editor takes click focus.
  await page.getByTestId('edit-toggle').click();
  await editor.locator('.cm-content').click();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => activeCell(page)).toEqual({ row: 0, col: 0 });

  // Navigate down to the `nested` raw VALUE cell (row 5) and across to its value.
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => activeCell(page)).toEqual({ row: 5, col: 1 });

  // Enter focuses the read-only textarea (for select/copy); it stays readonly.
  await page.keyboard.press('Enter');
  await expect.poll(() => activeTestId(page)).toBe('raw-nested');
  expect(
    await page.evaluate(() => document.activeElement?.hasAttribute('readonly')),
  ).toBe(true);

  // Escape exits back to nav mode on the same cell.
  await page.keyboard.press('Escape');
  expect(await activeIsInput(page)).toBe(false);
  await expect.poll(() => activeCell(page)).toEqual({ row: 5, col: 1 });
});
