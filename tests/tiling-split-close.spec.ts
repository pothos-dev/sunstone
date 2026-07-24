import { test, expect } from './fixtures';

/**
 * Slice: multi-concept-tiling (ticket 03).
 *
 * The editor area is a ROW OF COLUMNS, each a vertical stack of tiled Tiles.
 * Split Right opens the active Concept in a new column; Split Down opens it in a
 * new tile below. Dividers resize columns/tiles. The same Concept open in two
 * tiles shares one Document (an edit in one shows in the other). Closing a tile
 * focuses a neighbour; the Close affordance only appears while more than one
 * tile is on screen.
 */

const CM = 'concepts/codemirror.md';
const NEEDLE = 'CodeMirror 6 is the editor core';

async function openCodemirror(page: import('@playwright/test').Page) {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await tree.locator(`[data-path="${CM}"]`).click();
  await expect(page.getByTestId('editor')).toContainText(NEEDLE);
  // Read is the default; enter editing (global mode) so the shared-doc edit below
  // takes and split tiles inherit an editable view.
  await page.getByTestId('edit-toggle').click();
}

test('tiling: split right + down, resize a divider, shared-doc sync, close to neighbour then single', async ({
  page,
}) => {
  await openCodemirror(page);

  // One tile to start.
  await expect(page.getByTestId('editor')).toHaveCount(1);

  // --- Split Right → a second column, both showing the same Concept ----------
  await page.getByTestId('split-right').first().click();
  await expect(page.getByTestId('editor')).toHaveCount(2);
  await expect(page.getByTestId('column-divider')).toHaveCount(1);
  // Both tiles render the shared Concept.
  await expect(page.getByTestId('editor').nth(0)).toContainText(NEEDLE);
  await expect(page.getByTestId('editor').nth(1)).toContainText(NEEDLE);

  // --- Split Down (on the active/right tile) → a stacked tile in that column --
  await page.getByTestId('tile').last().getByTestId('split-down').click();
  await expect(page.getByTestId('editor')).toHaveCount(3);
  await expect(page.getByTestId('tile-divider')).toHaveCount(1);

  // --- Shared-Document sync: an edit in the FIRST tile shows in the others ----
  const first = page.getByTestId('editor').nth(0).locator('.cm-content');
  await first.click();
  // Move to the end of the doc, then type a sentinel.
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' SYNC_SENTINEL');
  // The untouched tiles (same Concept, shared buffer) reflect the edit.
  await expect(page.getByTestId('editor').nth(1)).toContainText('SYNC_SENTINEL');
  await expect(page.getByTestId('editor').nth(2)).toContainText('SYNC_SENTINEL');

  // --- Drag the column divider to resize -------------------------------------
  const col0 = page.locator('.editor-column').nth(0);
  const beforeWidth = (await col0.boundingBox())!.width;
  const divider = page.getByTestId('column-divider');
  const box = (await divider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const afterWidth = (await col0.boundingBox())!.width;
  expect(afterWidth).toBeGreaterThan(beforeWidth + 40);

  await page.screenshot({ path: 'tests/screenshots/tiling-split-close.png', fullPage: true });

  // --- Close a non-last tile → a neighbour becomes the active Tile -----------
  await page.getByTestId('tile').last().getByTestId('tile-close').click();
  await expect(page.getByTestId('editor')).toHaveCount(2);
  // Exactly one Tile is marked active (the focused neighbour).
  await expect(page.locator('[data-testid="tile"].tile-active')).toHaveCount(1);

  // --- Close down to the last tile → the Close affordance disappears ---------
  await page.getByTestId('tile').last().getByTestId('tile-close').click();
  await expect(page.getByTestId('editor')).toHaveCount(1);
  // With a single tile left, closing it would only clear it to the empty state,
  // so the Close affordance is no longer shown.
  await expect(page.getByTestId('tile-close')).toHaveCount(0);
});
