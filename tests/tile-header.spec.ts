import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * Slice: per-tile-header (single tile).
 *
 * The Tile grows a slim header carrying everything logically per-Tile for the
 * active Concept: the title + close, the Edit toggle (read ⇄ live editing; the
 * single view-mode control after editing-boolean-edit-toggle), Split Right /
 * Split Down, undo/redo over the Tile's Document history (shown only while
 * editing), the review-diff toggle, and Export-PDF. The Frontmatter toggle also
 * lives here now (moved from the deleted NavBar); the sidebars toggle from their
 * own edges.
 *
 * This drives the header controls end-to-end and screenshots the result.
 */

/** Read the persisted raw markdown of a Concept from the fake backend. */
function persisted(page: Page, path: string): Promise<string> {
  return page.evaluate(
    (p) =>
      (window as unknown as { __sunstoneFake: { files: Record<string, string> } }).__sunstoneFake
        .files[p],
    path,
  );
}

async function openCodemirror(page: Page) {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await tree.locator('[data-path="concepts/codemirror.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('CodeMirror 6 is the editor core');
  return editor;
}

test('tile header: Edit toggle, undo/redo, review + export live in the header', async ({
  page,
}) => {
  await openCodemirror(page);

  // The header renders with a derived title (frontmatter `title`) behind its
  // bundle-relative folder prefix (concept-header-path), plus its controls,
  // above the editor.
  const header = page.getByTestId('tile-header');
  await expect(header).toBeVisible();
  await expect(page.getByTestId('tile-title')).toHaveText('concepts/CodeMirror');
  await expect(page.getByTestId('tile-title-dir')).toHaveText('concepts/');
  // The tooltip carries the exact path, title-derived label or not.
  await expect(page.getByTestId('tile-title')).toHaveAttribute(
    'title',
    'concepts/codemirror.md',
  );

  // The per-Tile controls all live inside the header. The single view-mode
  // control is the Edit toggle here (there is no NavBar segmented control now).
  await expect(header.getByTestId('editor-mode-toggle')).toHaveCount(0);
  await expect(header.getByTestId('edit-toggle')).toBeVisible();
  await expect(header.getByTestId('review-toggle')).toBeVisible();
  await expect(header.getByTestId('export-pdf')).toBeVisible();
  await expect(header.getByTestId('split-right')).toBeVisible();
  await expect(header.getByTestId('split-down')).toBeVisible();
  await expect(header.getByTestId('nav-back')).toBeVisible();

  // --- Undo / redo appear only while editing (read-only has nothing to undo) --
  await expect(header.getByTestId('undo')).toHaveCount(0);
  await expect(header.getByTestId('redo')).toHaveCount(0);
  await header.getByTestId('edit-toggle').click();
  await expect(header.getByTestId('edit-toggle')).toHaveAttribute('aria-pressed', 'true');
  const undoBtn = header.getByTestId('undo');
  const redoBtn = header.getByTestId('redo');
  await expect(undoBtn).toBeVisible();
  await expect(redoBtn).toBeVisible();
  await expect(undoBtn).toBeDisabled();
  await expect(redoBtn).toBeDisabled();

  // Undo/redo sit to the LEFT of the Edit toggle in the control row (DOM order
  // == visual order here). The Edit toggle is a text button reading "Edit".
  await expect(header.getByTestId('edit-toggle')).toHaveText('Edit');
  const controls = header.locator('[data-testid]');
  const order = await controls.evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-testid')),
  );
  expect(order.indexOf('undo')).toBeLessThan(order.indexOf('edit-toggle'));
  expect(order.indexOf('redo')).toBeLessThan(order.indexOf('edit-toggle'));

  // Edit the frontmatter; the header undo enables. The Region is collapsed by
  // default (global toggle) — switch it on so the YAML editor is available.
  await page.getByTestId('frontmatter-toggle').click();
  const yaml = page.getByTestId('frontmatter').locator('.cm-content');
  await yaml.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown'); // the `title:` line
  await page.keyboard.press('End');
  await page.keyboard.type(' Renamed');
  await expect
    .poll(() => persisted(page, 'concepts/codemirror.md'))
    .toContain('title: CodeMirror Renamed');
  await expect(undoBtn).toBeEnabled();

  // Header undo reverts; redo re-applies — proving they drive the shared history.
  await undoBtn.click();
  await expect(yaml).not.toContainText('Renamed');
  await expect(redoBtn).toBeEnabled();
  await redoBtn.click();
  await expect(yaml).toContainText('title: CodeMirror Renamed');

  // --- Review toggle (reuses existing enablement) ---------------------------
  const reviewToggle = page.getByTestId('review-toggle');
  await expect(reviewToggle).toBeEnabled();
  await reviewToggle.click();
  await expect(reviewToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('review-editor')).toBeVisible();
  await reviewToggle.click();
  await expect(reviewToggle).toHaveAttribute('aria-pressed', 'false');

  // --- Export-PDF opens the print preview for this Concept ------------------
  const popupPromise = page.waitForEvent('popup');
  await page.getByTestId('export-pdf').click();
  const popup = await popupPromise;
  expect(decodeURIComponent(popup.url())).toContain('print=concepts/codemirror.md');

  await page.screenshot({ path: 'tests/screenshots/tile-header.png', fullPage: true });
});

test('tile header: close affordance is hidden when only one tile is on screen', async ({ page }) => {
  await openCodemirror(page);

  // With a single tile there is nothing to close down to (it would just clear to
  // the empty state), so the Close affordance is not rendered at all.
  await expect(page.getByTestId('tile-close')).toHaveCount(0);
});

test('no NavBar: Frontmatter toggle moved to the header; sidebars toggle from their edges', async ({
  page,
}) => {
  await openCodemirror(page);

  // The NavBar (the old global top bar) is GONE — a single open Concept shows
  // only its concept header, no bar above it.
  await expect(page.locator('nav[aria-label="Global controls"]')).toHaveCount(0);

  // The Frontmatter toggle now lives in the concept header, next to Edit. It
  // starts OFF (default hidden): no Frontmatter chrome in the tile.
  const header = page.getByTestId('tile-header');
  const propsToggle = header.getByTestId('frontmatter-toggle');
  await expect(propsToggle).toBeVisible();
  await expect(propsToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('frontmatter')).toHaveCount(0);
  // Toggling it ON reveals the tile's frontmatter inline; OFF hides it again.
  await propsToggle.click();
  await expect(propsToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('frontmatter')).toBeVisible();
  await propsToggle.click();
  await expect(propsToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('frontmatter')).toHaveCount(0);

  // The sidebar collapse/expand affordances are the toggle button at the top of
  // each activity rail — it reflects the open state via aria-pressed.
  const leftToggle = page.getByTestId('rail-toggle-left');
  const rightToggle = page.getByTestId('rail-toggle-right');
  await expect(leftToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(rightToggle).toHaveAttribute('aria-pressed', 'false');
  // Clicking the left rail's toggle collapses the left Sidebar.
  await leftToggle.click();
  await expect(leftToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('side-bar')).not.toBeVisible();
  // Clicking it again re-expands.
  await leftToggle.click();
  await expect(leftToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('side-bar')).toBeVisible();
});

test('tile header: window title names the open Concept', async ({ page }) => {
  await openCodemirror(page);
  await expect(page).toHaveTitle('CodeMirror — Sunstone');
});

test('tile header: breadcrumbs open a folder index and show it in the Explorer', async ({
  page,
}) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  // Open a nested Concept straight from the tree, expanding its folders first
  // when they are collapsed.
  const livePreview = tree.locator('[data-path="concepts/editor/live-preview.md"]');
  for (const folder of ['concepts', 'concepts/editor']) {
    const child = tree.locator(`[data-row-path^="${folder}/"]`).first();
    if (!(await child.isVisible())) await tree.locator(`.row[data-row-path="${folder}"]`).click();
  }
  await livePreview.click();

  const crumbs = page.getByTestId('tile-crumb');
  await expect(crumbs).toHaveText(['concepts', 'editor']);

  // `editor/` has no index.md: the crumb leaves the Concept open and just
  // expands + highlights the folder in the Explorer.
  await tree.locator('.row[data-row-path="concepts/editor"]').click(); // collapse it
  await expect(livePreview).toHaveCount(0);
  await crumbs.nth(1).click();
  await expect(page.getByTestId('tile-title')).toHaveAttribute('title', 'concepts/editor/live-preview.md');
  await expect(livePreview).toBeVisible();
  await expect(tree.locator('.row[data-row-path="concepts/editor"]')).toHaveClass(/focused-item/);

  // `concepts/` has an index.md: the crumb opens it.
  await crumbs.nth(0).click();
  await expect(page.getByTestId('tile-title')).toHaveAttribute('title', 'concepts/index.md');
  await expect(page.getByTestId('tile-crumb')).toHaveText(['concepts']);
  await expect(tree.locator('.row[data-row-path="concepts"]')).toHaveClass(/focused-item/);
});
