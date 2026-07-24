import { test, expect, type Page } from './fixtures';

/**
 * Slice: multi-concept-tiling (ticket 06 — layout persistence).
 *
 * The tiled workspace survives a relaunch. This drives the fake backend
 * (localStorage-backed, so a page RELOAD restores state exactly as the real
 * backend restores from the OS config file):
 *  - arrange a 2-column layout (column 1 stacks two tiles) on THREE different
 *    Concepts, with a chosen active tile and the GLOBAL view-mode set; reload and
 *    assert the columns/tiles, per-tile Concept, the global mode (shared by every
 *    tile), and the active tile all come back;
 *  - an OLD single-Concept session (`lastOpenConcept` + one `editorMode`, no
 *    `layout`) migrates cleanly to a single tile in that mode.
 */

const CM = 'concepts/codemirror.md';
const BUNDLE = 'concepts/bundle.md';
const LIVE = 'concepts/editor/live-preview.md';

const CM_NEEDLE = 'CodeMirror 6 is the editor core';
const BUNDLE_NEEDLE = 'is the root folder';
const LIVE_NEEDLE = 'Obsidian-style hybrid editing';

/** Seed a deterministic starting session (two folders expanded, nothing else). */
async function bootFresh(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();
  await page.evaluate(() =>
    window.localStorage.setItem(
      'sunstone:bundleState:/fake/bundle',
      JSON.stringify({ expandedFolders: ['concepts', 'concepts/editor'] }),
    ),
  );
  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();
}

test('layout persistence: a 2-column stacked layout + global mode + active tile survive a reload', async ({
  page,
}) => {
  await bootFresh(page);
  const tree = page.getByTestId('tree');

  // Tile 0 (column 0): codemirror.md.
  await tree.locator(`[data-path="${CM}"]`).click();
  await expect(page.getByTestId('editor').first()).toContainText(CM_NEEDLE);

  // Split Right → column 1, tile 1 (inherits codemirror). Open bundle.md there.
  await page.getByTestId('split-right').first().click();
  await expect(page.getByTestId('editor')).toHaveCount(2);
  await page.getByTestId('tile').nth(1).locator('.cm-content').click();
  await tree.locator(`[data-path="${BUNDLE}"]`).click();
  await expect(page.getByTestId('tile').nth(1).getByTestId('editor')).toContainText(BUNDLE_NEEDLE);

  // Split Down (in column 1) → tile 2 below bundle. Open live-preview.md there.
  await page.getByTestId('tile').nth(1).getByTestId('split-down').click();
  await expect(page.getByTestId('editor')).toHaveCount(3);
  await page.getByTestId('tile').nth(2).locator('.cm-content').click();
  await tree.locator(`[data-path="${LIVE}"]`).click();
  await expect(page.getByTestId('tile').nth(2).getByTestId('editor')).toContainText(LIVE_NEEDLE);

  // The view-mode is GLOBAL: toggle Editing on once (any tile's Edit toggle); it
  // applies to EVERY tile at once (all three become editable). Read is the
  // default, so editing is the non-trivial choice whose restoration we assert.
  await page.getByTestId('tile').nth(0).getByTestId('edit-toggle').click();
  await expect(page.getByTestId('tile').nth(0).getByTestId('edit-toggle')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  for (const i of [0, 1, 2]) {
    await expect(page.getByTestId('tile').nth(i).locator('.cm-content')).toHaveAttribute(
      'contenteditable',
      'true',
    );
  }

  // Make the MIDDLE tile (bundle, column 1 top) the active one — a non-trivial
  // choice (not the last-split tile) whose restoration proves the active tile is
  // persisted.
  await page.getByTestId('tile').nth(1).locator('.cm-content').click();
  await expect(page.locator('[data-testid="tile"].tile-active')).toHaveCount(1);
  await expect(page.getByTestId('tile').nth(1)).toHaveClass(/tile-active/);

  // Wait for the debounced layout save to flush: two columns, the second with two
  // tiles, active pointing at column 1 / tile 0.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('sunstone:bundleState:/fake/bundle');
        if (!raw) return null;
        const parsed = JSON.parse(raw) as {
          layout?: { columns: { tiles: unknown[] }[]; active: [number, number] };
        };
        const l = parsed.layout;
        if (!l) return null;
        return {
          columns: l.columns.length,
          col1Tiles: l.columns[1]?.tiles.length,
          active: l.active,
        };
      }),
    )
    .toEqual({ columns: 2, col1Tiles: 2, active: [1, 0] });

  await page.screenshot({ path: 'tests/screenshots/layout-persistence.png', fullPage: true });

  // RELOAD: the whole workspace is reconstructed.
  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();

  // Structure: 3 tiles, one column divider (2 columns), one tile divider (the
  // stacked column).
  await expect(page.getByTestId('editor')).toHaveCount(3);
  await expect(page.getByTestId('column-divider')).toHaveCount(1);
  await expect(page.getByTestId('tile-divider')).toHaveCount(1);

  // Per-tile Concepts, in row-major order (col0, then col1 top→bottom).
  await expect(page.getByTestId('tile').nth(0).getByTestId('editor')).toContainText(CM_NEEDLE);
  await expect(page.getByTestId('tile').nth(1).getByTestId('editor')).toContainText(BUNDLE_NEEDLE);
  await expect(page.getByTestId('tile').nth(2).getByTestId('editor')).toContainText(LIVE_NEEDLE);

  // The global mode (Editing) is restored and applies to every tile: each tile's
  // Edit toggle shows it, and all three tiles come back editable.
  await expect(page.getByTestId('tile').nth(0).getByTestId('edit-toggle')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  for (const i of [0, 1, 2]) {
    await expect(page.getByTestId('tile').nth(i).locator('.cm-content')).toHaveAttribute(
      'contenteditable',
      'true',
    );
  }

  // The active tile (middle = bundle) is restored as the active Tile.
  await expect(page.locator('[data-testid="tile"].tile-active')).toHaveCount(1);
  await expect(page.getByTestId('tile').nth(1)).toHaveClass(/tile-active/);
});

test('layout persistence: an OLD single-Concept session migrates to one tile', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();

  // Seed a legacy session: only lastOpenConcept + a single editorMode, NO layout.
  await page.evaluate(() =>
    window.localStorage.setItem(
      'sunstone:bundleState:/fake/bundle',
      JSON.stringify({
        lastOpenConcept: 'concepts/codemirror.md',
        editorMode: 'view',
        expandedFolders: ['concepts'],
      }),
    ),
  );
  await page.reload();
  await expect(page.getByTestId('tree')).toBeVisible();

  // Migrates to a SINGLE tile showing that Concept in that mode — no dividers.
  await expect(page.getByTestId('editor')).toHaveCount(1);
  await expect(page.getByTestId('column-divider')).toHaveCount(0);
  await expect(page.getByTestId('tile-divider')).toHaveCount(0);
  await expect(page.getByTestId('editor')).toContainText(CM_NEEDLE);
  // The legacy 'view' mode migrates to 'read' (Edit toggle off, read-only).
  await expect(page.getByTestId('edit-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
});
