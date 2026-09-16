import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';

/**
 * Slice: explorer-crud-keybindings.
 *
 * Single-letter keybindings fire the EXISTING TreeCrud dialogs on the
 * Explorer's Focused item (the keyboard cursor — a tree row), so create / rename
 * / move / delete never need the mouse:
 *   r / F2 → rename, d / Delete → delete, a → New Concept, A → New Folder,
 *   m → move.
 *
 * Asserts each key opens the correct dialog, the new-target rule (inside a
 * folder vs. sibling of a file), that committing returns focus to the Explorer
 * at the affected row, delete still confirms, and that the verbs do NOT fire
 * while focus is inside a dialog's text input.
 */

/** The bundle-relative path of the row that currently holds DOM focus. */
async function focusedRow(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return el instanceof HTMLElement ? (el.getAttribute('data-row-path') ?? null) : null;
  });
}

async function freshLoad(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  await page.evaluate(() => window.localStorage.setItem('sunstone:bundleState:/fake/bundle', JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'] })));
  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();
}

/** Click a row to make it the Focused item (keyboard cursor). */
async function focusFileRow(page: Page, path: string) {
  await page.getByTestId('tree').locator(`.row[data-row-path="${path}"]`).click();
  await expect.poll(() => focusedRow(page)).toBe(path);
}

test('keyboard CRUD: rename via r / F2 opens the rename dialog on the Focused item', async ({
  page,
}) => {
  await freshLoad(page);
  const tree = page.getByTestId('tree');

  await focusFileRow(page, 'concepts/codemirror.md');

  // `r` opens the rename dialog pre-filled with the node's name WITHOUT its
  // `.md` extension — the extension is implicit for concepts.
  await page.keyboard.press('r');
  await expect(page.getByTestId('tree-dialog')).toContainText('Rename');
  await expect(page.getByTestId('dialog-input')).toHaveValue('codemirror');

  // Commit a rename WITHOUT typing `.md`; it's re-appended implicitly. The
  // affected (renamed) row becomes the Focused item.
  await page.getByTestId('dialog-input').fill('renamed-by-key');
  await page.getByTestId('dialog-confirm').click();
  const renamed = 'concepts/renamed-by-key.md';
  await expect(tree.locator(`[data-path="${renamed}"]`)).toBeVisible();
  await expect(tree.locator(`[data-path="concepts/codemirror.md"]`)).toHaveCount(0);
  await expect.poll(() => focusedRow(page)).toBe(renamed);

  // `F2` is an alias for rename.
  await page.keyboard.press('F2');
  await expect(page.getByTestId('tree-dialog')).toContainText('Rename');
  await expect(page.getByTestId('dialog-input')).toHaveValue('renamed-by-key');

  // The verbs must NOT fire while typing in the dialog input: typing `a`/`d`/`m`
  // into the field is text entry, not a new CRUD action — the SAME rename dialog
  // stays open (no second dialog stacks on top).
  await page.getByTestId('dialog-input').fill('typed-amd');
  await page.keyboard.press('a');
  await page.keyboard.press('d');
  await page.keyboard.press('m');
  await expect(page.getByTestId('tree-dialog')).toHaveCount(1);
  await expect(page.getByTestId('tree-dialog')).toContainText('Rename');

  // Cancel restores focus to the Explorer at the row it was on.
  await page.getByTestId('tree-dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('tree-dialog')).toHaveCount(0);
  await expect.poll(() => focusedRow(page)).toBe(renamed);
});

test('keyboard CRUD: a → New Concept (sibling of a file), A → New Folder (inside a folder)', async ({
  page,
}) => {
  await freshLoad(page);
  const tree = page.getByTestId('tree');

  // Focused item is a FILE → New Concept lands as a SIBLING (its parent folder).
  await focusFileRow(page, 'concepts/bundle.md');
  await page.keyboard.press('a');
  await expect(page.getByTestId('tree-dialog')).toContainText('New Concept');
  await page.getByTestId('dialog-input').fill('keyboard-note');
  await page.getByTestId('dialog-confirm').click();

  const created = 'concepts/keyboard-note.md';
  await expect(tree.locator(`[data-path="${created}"]`)).toBeVisible();
  // Committing returns focus to the Explorer at the newly-created row.
  await expect.poll(() => focusedRow(page)).toBe(created);

  // Focused item is a FOLDER → A (Shift+a) creates a New Folder INSIDE it.
  // Reach the folder by ArrowLeft (jump-to-parent) from a child file, so we land
  // on `concepts/editor` WITHOUT toggling its expansion (a click would collapse).
  await focusFileRow(page, 'concepts/editor/live-preview.md');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => focusedRow(page)).toBe('concepts/editor');
  await page.keyboard.press('Shift+A');
  await expect(page.getByTestId('tree-dialog')).toContainText('New Folder');
  await page.getByTestId('dialog-input').fill('nested');
  await page.getByTestId('dialog-confirm').click();

  const nestedFolder = 'concepts/editor/nested';
  await expect(tree.locator(`[data-row-path="${nestedFolder}"]`)).toHaveCount(1);
  await expect.poll(() => focusedRow(page)).toBe(nestedFolder);

  await page.screenshot({ path: 'tests/screenshots/explorer-crud-keys.png', fullPage: true });
});

test('keyboard CRUD: m → move dialog; commit refocuses the moved row', async ({ page }) => {
  await freshLoad(page);
  const tree = page.getByTestId('tree');

  // Create a destination folder inside `concepts`. Reach the folder by
  // ArrowLeft (jump-to-parent) from a child file so its expansion is untouched.
  await focusFileRow(page, 'concepts/bundle.md');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => focusedRow(page)).toBe('concepts');
  await page.keyboard.press('Shift+A');
  await page.getByTestId('dialog-input').fill('archive');
  await page.getByTestId('dialog-confirm').click();
  await expect(tree.locator(`[data-row-path="concepts/archive"]`)).toHaveCount(1);

  // Focus a Concept and move it via `m` into the archive folder.
  await focusFileRow(page, 'concepts/links-demo.md');
  await page.keyboard.press('m');
  await expect(page.getByTestId('tree-dialog')).toContainText('Move');
  await page.getByTestId('dialog-move-target').selectOption('concepts/archive');
  await page.getByTestId('dialog-confirm').click();

  const moved = 'concepts/archive/links-demo.md';
  await expect(tree.locator(`[data-path="concepts/links-demo.md"]`)).toHaveCount(0);
  await expect(tree.locator(`[data-path="${moved}"]`)).toBeVisible();
  await expect.poll(() => focusedRow(page)).toBe(moved);
});

test('keyboard CRUD: d / Delete confirms, then refocuses a neighbour row', async ({ page }) => {
  await freshLoad(page);
  const tree = page.getByTestId('tree');

  // `d` opens the delete CONFIRM dialog — nothing is removed until confirmed.
  await focusFileRow(page, 'concepts/codemirror.md');
  await page.keyboard.press('d');
  await expect(page.getByTestId('tree-dialog')).toContainText('Delete');
  await expect(tree.locator('[data-path="concepts/codemirror.md"]')).toBeVisible();

  await page.getByTestId('dialog-confirm').click();
  await expect(tree.locator('[data-path="concepts/codemirror.md"]')).toHaveCount(0);
  // Focus lands on a sensible neighbour row (a real, still-present row).
  const after = await focusedRow(page);
  expect(after).not.toBeNull();
  expect(after).not.toBe('concepts/codemirror.md');
  await expect(tree.locator(`.row[data-row-path="${after}"]`)).toHaveCount(1);

  // `Delete` is an alias for `d`.
  await focusFileRow(page, 'concepts/bundle.md');
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('tree-dialog')).toContainText('Delete');
  await page.getByTestId('dialog-confirm').click();
  await expect(tree.locator('[data-path="concepts/bundle.md"]')).toHaveCount(0);
});
