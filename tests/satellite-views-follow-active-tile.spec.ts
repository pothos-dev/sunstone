import { test, expect, type Page } from './fixtures';

/**
 * Slice: multi-concept-tiling (ticket 05 — satellite views follow the active tile).
 *
 * With two tiles open on DIFFERENT Concepts:
 *  - the GLOBAL Properties toggle shows/hides Properties in EVERY visible tile at
 *    once; when on, each tile shows ITS OWN Concept's frontmatter inline; when
 *    off, no tile shows any Properties chrome (zero height cost),
 *  - Outline and Backlinks (right Sidebar) describe the ACTIVE tile's Concept and
 *    update as focus moves between tiles.
 */

const CM = 'concepts/codemirror.md';
const BUNDLE = 'concepts/bundle.md';

/** The id of the Region currently showing the active-Region affordance. */
async function activeRegion(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector('.region-active[data-region]');
    return el ? el.getAttribute('data-region') : null;
  });
}

/** Open two tiles on different Concepts: tile 0 = codemirror, tile 1 = bundle. */
async function twoTiles(page: Page) {
  await page.goto('/');
  let tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  // `editorMode: editing` so each tile's editor is focusable — clicking a tile's
  // editor below must activate it, which read (the default) prevents.
  await page.evaluate(() =>
    window.localStorage.setItem(
      'sunstone:bundleState:/fake/bundle',
      JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'], editorMode: 'editing' }),
    ),
  );
  await page.reload();
  tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // Tile 0 = codemirror.md.
  await tree.locator(`[data-path="${CM}"]`).click();
  await expect(page.getByTestId('editor').first()).toContainText('CodeMirror 6 is the editor core');

  // Reveal the right Sidebar so Outline + Backlinks are on screen.
  await page.getByTestId('right-sidebar-edge').click();
  await expect(page.getByTestId('outline')).toBeVisible();

  // Split into a second tile, then open bundle.md in it (the split leaves the new
  // tile active; opening from the tree targets the active tile).
  await page.getByTestId('split-right').first().click();
  await expect(page.getByTestId('editor')).toHaveCount(2);
  await page.getByTestId('tile').nth(1).locator('.cm-content').click();
  await tree.locator(`[data-path="${BUNDLE}"]`).click();
  await expect(page.getByTestId('tile').nth(1).getByTestId('editor')).toContainText(
    'is the root folder',
  );
  // Tile 0 still holds codemirror.
  await expect(page.getByTestId('tile').nth(0).getByTestId('editor')).toContainText(
    'CodeMirror 6 is the editor core',
  );
}

test('two tiles: the global Properties toggle shows/hides EVERY tile\'s own frontmatter', async ({
  page,
}) => {
  await twoTiles(page);

  const tile0 = page.getByTestId('tile').nth(0);
  const tile1 = page.getByTestId('tile').nth(1);

  // Default HIDDEN: no Properties chrome in either tile.
  await expect(page.getByTestId('properties')).toHaveCount(0);

  // Toggle ON: BOTH tiles render their OWN Concept's frontmatter inline. The
  // Properties toggle now lives in EACH tile's header (one per tile), so target
  // the first — it drives the shared global flag for every tile.
  await page.getByTestId('properties-toggle').first().click();
  await expect(page.getByTestId('properties')).toHaveCount(2);
  await expect(tile0.getByTestId('scalar-title')).toHaveValue('CodeMirror');
  await expect(tile1.getByTestId('scalar-title')).toHaveValue('Bundle');

  await page.screenshot({
    path: 'tests/screenshots/satellite-views-follow-active-tile.png',
    fullPage: true,
  });

  // Editing one tile's frontmatter targets THAT tile's Document (per-tile). Click
  // into tile 1's field first — the Properties toggle above left tile 0 active, so
  // interacting with tile 1 activates it (a real mousedown, as a user would do).
  await tile1.getByTestId('scalar-title').click();
  await tile1.getByTestId('scalar-title').fill('Bundle Renamed');
  await tile1.getByTestId('scalar-title').blur();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __sunstoneFake: { files: Record<string, string> } })
            .__sunstoneFake.files['concepts/bundle.md'],
      ),
    )
    .toContain('title: Bundle Renamed');
  // Tile 0's Concept is untouched.
  await expect(tile0.getByTestId('scalar-title')).toHaveValue('CodeMirror');

  // Toggle OFF: NO tile shows any Properties chrome.
  await page.getByTestId('properties-toggle').first().click();
  await expect(page.getByTestId('properties')).toHaveCount(0);
});

test('two tiles: Outline and Backlinks follow the ACTIVE tile', async ({ page }) => {
  await twoTiles(page);

  // Activate tile 1 (bundle): Outline lists bundle's heading. Backlinks describe
  // bundle — and since bundle is NOT linked by codemirror, codemirror does not
  // appear as a backlink here.
  await page.getByTestId('tile').nth(1).locator('.cm-content').click();
  await expect.poll(() => activeRegion(page)).toBe('editor');
  await expect(page.getByTestId('outline')).toContainText('Bundle');
  await expect(
    page.getByTestId('backlinks').locator('[data-path="concepts/bundle.md"]'),
  ).toHaveCount(0);

  // Activate tile 0 (codemirror): the satellite views switch to describe it.
  // codemirror.md IS linked by bundle.md, so bundle now appears as a backlink —
  // proving Backlinks tracks the active tile, not a fixed Concept.
  await page.getByTestId('tile').nth(0).locator('.cm-content').click();
  await expect(page.getByTestId('outline')).toContainText('CodeMirror');
  await expect(
    page.getByTestId('backlinks').locator('[data-path="concepts/bundle.md"]'),
  ).toHaveCount(1);
});
