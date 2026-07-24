import { test, expect, type Page } from '@playwright/test';

/**
 * Slice: explorer-keyboard-nav.
 *
 * Full keyboard navigation inside the Explorer, with the Focused item (the
 * keyboard cursor — a tree row) decoupled from the open Concept (docs/GLOSSARY.md).
 *
 * Drives the unmodified arrow/hjkl/Enter/Home/End keys over the visible rows,
 * asserts clamp-at-the-ends (no wrap), expand/collapse/descend/jump-to-parent,
 * roving tabindex (exactly one focusable row), Enter-opens-a-file-and-moves-
 * focus-to-the-Editor, the Focused-item ring vs open-Concept accent distinction,
 * and that the Focused item is remembered across Alt-away / Alt-back.
 */

/** The bundle-relative path of the row that currently holds DOM focus. */
async function focusedRow(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return el instanceof HTMLElement ? (el.getAttribute('data-row-path') ?? null) : null;
  });
}

/** The single tab-focusable row (tabindex=0), or null. */
async function rovingRow(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector('.row[tabindex="0"]');
    return el ? el.getAttribute('data-row-path') : null;
  });
}

/** Count of rows that are tab-focusable (tabindex=0) — must be exactly one. */
async function rovingCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('.row[tabindex="0"]').length);
}

async function freshLoad(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  // Seed a deterministic tree state: `concepts/` + `concepts/editor/` expanded.
  // All folders open COLLAPSED by default; seeding the expanded set keeps these
  // keyboard-nav assertions focused on movement rather than the collapse default.
  // `editorMode: editing` so a Concept opened below is editable and thus takes
  // focus (read — the default — is not focusable; focus would never leave the tree).
  await page.evaluate(() => window.localStorage.setItem('sunstone:bundleState:/fake/bundle', JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'], editorMode: 'editing' })));
  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();
}

test('on first load the keyboard cursor starts in the Explorer', async ({ page }) => {
  await freshLoad(page);
  // Nothing clicked: focus auto-lands on the first visible tree row, so the app
  // opens WITH a Focused item (the Explorer is the active Region) rather than
  // with focus nowhere.
  await expect(page.locator('.region-active[data-region="explorer"]')).toBeVisible();
  await expect.poll(() => focusedRow(page)).toBe('concepts');
  await expect.poll(() => rovingCount(page)).toBe(1);
});

test('Explorer keyboard nav: move/expand/collapse/descend/parent, clamp, roving tabindex', async ({
  page,
}) => {
  await freshLoad(page);
  const tree = page.getByTestId('tree');

  // Enter the Explorer by clicking a FILE row (clicking a folder row's body
  // would hit its toggle). A click makes the row the Focused item (roving
  // tabindex) without arrowing yet. `concepts` + `concepts/editor` are seeded
  // expanded by `freshLoad`, so the nested file is visible.
  await tree.locator('.row[data-row-path="concepts/editor/live-preview.md"]').click();
  await expect.poll(() => rovingRow(page)).toBe('concepts/editor/live-preview.md');
  await expect.poll(() => rovingCount(page)).toBe(1);
  await expect.poll(() => focusedRow(page)).toBe('concepts/editor/live-preview.md');

  // Home jumps to the first visible row; ArrowUp there clamps (no wrap).
  await page.keyboard.press('Home');
  await expect.poll(() => focusedRow(page)).toBe('concepts');
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => focusedRow(page)).toBe('concepts');

  // `concepts` is seeded expanded (see `freshLoad`); ArrowRight on an expanded
  // folder descends into its first child — the `concepts/editor` folder.
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => focusedRow(page)).toBe('concepts/editor');

  // ArrowLeft on an expanded folder collapses it (focus stays on the folder).
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => focusedRow(page)).toBe('concepts/editor');
  await expect(tree.locator('.row[data-row-path="concepts/editor"]')).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  // Its child row is gone from the DOM now that it is collapsed.
  await expect(
    tree.locator('.row[data-row-path="concepts/editor/live-preview.md"]'),
  ).toHaveCount(0);

  // ArrowRight on a collapsed folder expands it (child reappears, focus stays).
  await page.keyboard.press('ArrowRight');
  await expect(tree.locator('.row[data-row-path="concepts/editor"]')).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(
    tree.locator('.row[data-row-path="concepts/editor/live-preview.md"]'),
  ).toBeVisible();
  await expect.poll(() => focusedRow(page)).toBe('concepts/editor');

  // ArrowDown moves to the next visible row — the expanded folder's child file.
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusedRow(page)).toBe('concepts/editor/live-preview.md');

  // `j` (vim down) moves to the next visible row — the first sibling Concept
  // (files sort after the `editor/` folder; `annotated.md` leads alphabetically).
  await page.keyboard.press('j');
  await expect.poll(() => focusedRow(page)).toBe('concepts/annotated.md');

  // `k` (vim up) moves back up.
  await page.keyboard.press('k');
  await expect.poll(() => focusedRow(page)).toBe('concepts/editor/live-preview.md');

  // ArrowLeft on a file jumps to its PARENT folder row.
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => focusedRow(page)).toBe('concepts/editor');

  // End jumps to the last visible row; ArrowDown there clamps (no wrap).
  await page.keyboard.press('End');
  const last = await focusedRow(page);
  expect(last).toBe('concepts/search-overflow.md');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusedRow(page)).toBe('concepts/search-overflow.md');

  // Home jumps back to the first visible row.
  await page.keyboard.press('Home');
  await expect.poll(() => focusedRow(page)).toBe('concepts');

  // Roving tabindex invariant holds throughout: exactly one focusable row.
  await expect.poll(() => rovingCount(page)).toBe(1);
});

test('Enter opens a file (focus → Editor) and the Focused-item ring is distinct from the open accent', async ({
  page,
}) => {
  await freshLoad(page);
  const tree = page.getByTestId('tree');
  const editor = page.getByTestId('editor');

  // Focus a Concept row, then Enter to open it and move focus to the Editor.
  await tree.locator('.row[data-row-path="concepts/codemirror.md"]').click();
  await expect.poll(() => focusedRow(page)).toBe('concepts/codemirror.md');
  await page.keyboard.press('Enter');

  // The Concept opened in the Editor and focus moved there (out of the tree).
  await expect(editor).toContainText('CodeMirror 6 is the editor core');
  await expect.poll(() =>
    page.evaluate(() => {
      const el = document.activeElement;
      return !!el && !!el.closest('.cm-editor');
    }),
  ).toBe(true);

  // The open Concept's row carries the filled-accent "open" marker.
  const openRow = tree.locator('.row[data-row-path="concepts/codemirror.md"]');
  await expect(openRow.locator('.file-entry.selected')).toHaveCount(1);

  // Right after Enter the Focused item and open Concept coincide on that row.
  await expect.poll(() => rovingRow(page)).toBe('concepts/codemirror.md');

  // Re-enter the Explorer and arrow away: the Focused item (ring) DIVERGES from
  // the open Concept (filled accent). Move focus into the tree via Alt+Left, then
  // arrow down to a different row.
  await editor.locator('.cm-content').click();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.locator('.region-active[data-region="explorer"]')).toBeVisible();
  await page.keyboard.press('ArrowDown'); // off the open Concept onto a neighbour

  const focused = await focusedRow(page);
  expect(focused).not.toBe('concepts/codemirror.md');

  // Two distinct affordances now: the open Concept keeps the filled accent on a
  // DIFFERENT row than the Focused-item ring.
  await expect(openRow.locator('.file-entry.selected')).toHaveCount(1); // still the open one
  await expect(page.locator(`.row.focused-item[data-row-path="${focused}"]`)).toHaveCount(1);
  // The Focused item is NOT the open Concept's row.
  await expect(
    page.locator('.row.focused-item[data-row-path="concepts/codemirror.md"]'),
  ).toHaveCount(0);

  await page.screenshot({ path: 'tests/screenshots/explorer-keyboard-nav.png', fullPage: true });
});

test('the Explorer Focused item is remembered across Alt-away / Alt-back', async ({ page }) => {
  await freshLoad(page);
  const tree = page.getByTestId('tree');
  const editor = page.getByTestId('editor');

  // Open a Concept so the Editor Region exists to move away to.
  await tree.locator('.row[data-row-path="concepts/codemirror.md"]').click();
  await page.keyboard.press('Enter');
  await expect(editor).toContainText('CodeMirror 6 is the editor core');

  // Enter the Explorer and arrow to a specific row.
  await editor.locator('.cm-content').click();
  await page.keyboard.press('Alt+ArrowLeft');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const remembered = await focusedRow(page);
  expect(remembered).not.toBeNull();

  // Leave to the Editor (Escape), then return (Alt+Left). The same row regains
  // focus — sticky per-Region item memory from the focus backbone.
  await page.keyboard.press('Escape');
  await expect.poll(() =>
    page.evaluate(() => {
      const el = document.activeElement;
      return !!el && !!el.closest('.cm-editor');
    }),
  ).toBe(true);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => focusedRow(page)).toBe(remembered);
});
