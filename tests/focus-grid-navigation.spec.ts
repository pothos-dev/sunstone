import { test, expect, type Page } from './fixtures';

/**
 * Slice: multi-concept-tiling (ticket 04 — focus grid navigation).
 *
 * The editor area stays ONE logical 'editor' Region that internally owns a 2D
 * tile grid. With focus in the editor:
 *   - Alt+Left/Right move between COLUMNS,
 *   - Alt+Up/Down move between TILES within the current column.
 * At the grid's edge the move DELEGATES to the Region backbone: Alt+Left from the
 * leftmost column crosses into the Explorer sidebar, Alt+Right from the rightmost
 * crosses into the right (Outline/Backlinks) sidebar. Leaving and re-entering a
 * column lands on the tile you were last on there (sticky per-column memory).
 */

const CM = 'concepts/codemirror.md';
const NEEDLE = 'CodeMirror 6 is the editor core';

/** The id of the Region currently showing the active-Region affordance. */
async function activeRegion(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector('.region-active[data-region]');
    return el ? el.getAttribute('data-region') : null;
  });
}
async function expectActiveRegion(page: Page, id: string) {
  await expect.poll(() => activeRegion(page)).toBe(id);
}

/** Assert exactly one tile is the active Tile and it is the `index`-th tile. */
async function expectActiveTile(page: Page, index: number) {
  await expect(page.locator('[data-testid="tile"].tile-active')).toHaveCount(1);
  await expect(page.getByTestId('tile').nth(index)).toHaveClass(/tile-active/);
}

async function altPress(page: Page, key: string) {
  await page.keyboard.press(`Alt+${key}`);
}

test('editor grid: Alt+arrow moves across columns/tiles, delegates at edges, sticky per-column', async ({
  page,
}) => {
  await page.goto('/');
  let tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.evaluate(() =>
    window.localStorage.setItem(
      'sunstone:bundleState:/fake/bundle',
      JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'] }),
    ),
  );
  await page.reload();
  tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  await tree.locator(`[data-path="${CM}"]`).click();
  await expect(page.getByTestId('editor')).toContainText(NEEDLE);

  // Enter editing so the editor takes click focus (read is the default; a
  // read-only view is not click-focusable, which the grid nav below relies on).
  await page.getByTestId('edit-toggle').click();

  // Reveal the right Sidebar so the rightmost-edge delegation has a target.
  await page.getByTestId('right-sidebar-toggle').click();
  await expect(page.getByTestId('outline')).toBeVisible();
  await expect(page.getByTestId('backlinks')).toBeVisible();

  // Build the layout: col0 = [p1], col1 = [p2, p3].
  await page.getByTestId('split-right').first().click(); // [p1 | p2]
  await expect(page.getByTestId('editor')).toHaveCount(2);
  await page.getByTestId('tile').last().getByTestId('split-down').click(); // col1 → [p2, p3]
  await expect(page.getByTestId('editor')).toHaveCount(3);
  await expect(page.getByTestId('column-divider')).toHaveCount(1);
  await expect(page.getByTestId('tile-divider')).toHaveCount(1);

  // Focus the TOP tile of the right column (p2). DOM order is p1, p2, p3.
  await page.getByTestId('editor').nth(1).locator('.cm-content').click();
  await expectActiveRegion(page, 'editor');
  await expectActiveTile(page, 1);

  // Alt+Down within the column → the stacked tile below (p3).
  await altPress(page, 'ArrowDown');
  await expectActiveRegion(page, 'editor');
  await expectActiveTile(page, 2);

  // Alt+Up → back to p2.
  await altPress(page, 'ArrowUp');
  await expectActiveTile(page, 1);

  // Go back down to p3 so we LEAVE the right column on its BOTTOM tile (sets up
  // the sticky-memory assertion below — the default landing would be the top).
  await altPress(page, 'ArrowDown');
  await expectActiveTile(page, 2);

  // Alt+Left → cross into the left column (p1, its only tile).
  await altPress(page, 'ArrowLeft');
  await expectActiveRegion(page, 'editor');
  await expectActiveTile(page, 0);

  // Alt+Left again from the LEFTMOST column → delegate into the Explorer sidebar.
  await altPress(page, 'ArrowLeft');
  await expectActiveRegion(page, 'explorer');

  // Alt+Right returns from the sidebar to the editor, landing on the last active
  // tile (p1 — the Region backbone remembers the editor's last focus).
  await altPress(page, 'ArrowRight');
  await expectActiveRegion(page, 'editor');
  await expectActiveTile(page, 0);

  // Sticky per-column memory: Alt+Right into the right column returns to p3 (the
  // tile last focused there), NOT the top tile p2.
  await altPress(page, 'ArrowRight');
  await expectActiveRegion(page, 'editor');
  await expectActiveTile(page, 2);

  await page.screenshot({ path: 'tests/screenshots/focus-grid-navigation.png', fullPage: true });

  // Alt+Right from the RIGHTMOST column → delegate into the right sidebar.
  await altPress(page, 'ArrowRight');
  await expectActiveRegion(page, 'backlinks');
});
