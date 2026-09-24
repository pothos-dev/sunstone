import { test, expect } from './fixtures';

/**
 * Slice: outline-active-heading.
 *
 * The Outline highlights the Current heading — the last heading at or above a
 * probe ~50px below the editor viewport's top, i.e. the resting spot an Outline
 * click scrolls a heading to. This asserts:
 *  - opening a Concept marks its first heading Current (top of the document),
 *  - clicking an entry makes THAT entry Current (the click scrolls the heading to
 *    the probe), and
 *  - scrolling the editor back to the top walks the highlight back up.
 */
test('the Outline marks the heading whose section is being read', async ({ page }) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  await page.evaluate(() =>
    window.localStorage.setItem(
      'sunstone:bundleState:/fake/bundle',
      JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'] }),
    ),
  );
  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();

  await page.getByTestId('rail-toggle-right').click();
  await page.getByTestId('tree').locator('[data-path="concepts/outline-demo.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('Intro prose under the top-level heading');

  const entries = page.getByTestId('outline').getByTestId('outline-entry');
  await expect(entries).toHaveCount(4);
  const current = page.getByTestId('outline').locator('[data-current="true"]');

  // At the top of the document the H1 is the Current heading.
  await expect(current).toHaveText('Outline Demo');

  // Clicking an entry scrolls that heading to the probe → it becomes Current.
  await entries.nth(3).click();
  await expect(current).toHaveText('Second Section');
  await expect(entries.nth(3)).toHaveAttribute('aria-current', 'true');
  await expect(entries.nth(0)).not.toHaveAttribute('data-current', 'true');

  await page.screenshot({ path: 'tests/screenshots/outline-active-heading.png', fullPage: true });

  // Natural scrolling drives it too: scroll the editor back to the top.
  await editor.locator('.cm-scroller').evaluate((el) => el.scrollTo({ top: 0 }));
  await expect(current).toHaveText('Outline Demo');

  // A heading on the LAST line can still become Current: the editor keeps a
  // blank scroll tail after the final line, so even it can reach the probe.
  // Without the tail the document simply runs out of scroll and the highlight
  // stays stuck on an earlier heading.
  await page.getByTestId('edit-toggle').click();
  await editor.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n## Very Last Heading');
  const entries2 = page.getByTestId('outline').getByTestId('outline-entry');
  await expect(entries2).toHaveCount(5);
  await entries2.nth(4).click();
  await expect(current).toHaveText('Very Last Heading');
});

/**
 * Only the active Tile feeds the Outline's Current heading, so activating a
 * different Tile must re-report from THAT Tile's viewport — not keep the line
 * the previously active Tile last reported.
 */
test('the Current heading follows the active Tile when focus moves between tiles', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() =>
    window.localStorage.setItem(
      'sunstone:bundleState:/fake/bundle',
      JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'] }),
    ),
  );
  await page.reload();
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  await page.getByTestId('rail-toggle-right').click();
  await tree.locator('[data-path="concepts/outline-demo.md"]').click();
  await expect(page.getByTestId('editor')).toContainText('Intro prose under the top-level heading');

  // Split Right → the new (right) tile is active; show a different Concept in it.
  await page.getByTestId('split-right').first().click();
  await expect(page.getByTestId('editor')).toHaveCount(2);
  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  const tiles = page.getByTestId('tile');
  await expect(tiles.nth(1).getByTestId('editor')).toContainText('CodeMirror 6 is the editor core');

  // Scroll the INACTIVE left tile (outline-demo) to its end: its report is
  // dropped while it is inactive, so the Outline still reflects the right tile.
  await tiles
    .nth(0)
    .locator('.cm-scroller')
    .evaluate((el) => el.scrollTo({ top: el.scrollHeight }));

  // Activate the left tile: the Outline lists outline-demo's headings, and the
  // Current one is where THAT tile is scrolled to — its last heading.
  await tiles.nth(0).locator('.cm-content').click();
  await expect(page.locator('[data-testid="tile"].tile-active')).toHaveCount(1);
  await expect(tiles.nth(0)).toHaveClass(/tile-active/);
  const entries = page.getByTestId('outline').getByTestId('outline-entry');
  await expect(entries).toHaveCount(4);
  const current = page.getByTestId('outline').locator('[data-current="true"]');
  await expect(current).toHaveText('Second Section');
});
