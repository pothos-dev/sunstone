import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * Slice: per-tile-header (single tile).
 *
 * The Tile grows a slim header carrying everything logically per-Tile for the
 * active Concept: the title + close, the Edit toggle (read ⇄ live editing; the
 * single view-mode control after editing-boolean-edit-toggle), Split Right /
 * Split Down, undo/redo over the Tile's Document history (shown only while
 * editing), the review-diff toggle, and Export-PDF. The Properties toggle also
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

  // The header renders with a derived title (frontmatter `title`) and its
  // controls, above the editor.
  const header = page.getByTestId('tile-header');
  await expect(header).toBeVisible();
  await expect(page.getByTestId('tile-title')).toHaveText('CodeMirror');

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

  // Edit a property; the header undo enables. Properties is hidden by default
  // (global toggle) — switch it on so the frontmatter inputs are available.
  await page.getByTestId('properties-toggle').click();
  const titleInput = page.getByTestId('scalar-title');
  await titleInput.fill('CodeMirror Renamed');
  await titleInput.blur();
  await expect
    .poll(() => persisted(page, 'concepts/codemirror.md'))
    .toContain('title: CodeMirror Renamed');
  await expect(undoBtn).toBeEnabled();

  // Header undo reverts; redo re-applies — proving they drive the shared history.
  await undoBtn.click();
  await expect(page.getByTestId('scalar-title')).toHaveValue('CodeMirror');
  await expect(redoBtn).toBeEnabled();
  await redoBtn.click();
  await expect(page.getByTestId('scalar-title')).toHaveValue('CodeMirror Renamed');

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

test('no NavBar: Properties toggle moved to the header; sidebars toggle from their edges', async ({
  page,
}) => {
  await openCodemirror(page);

  // The NavBar (the old global top bar) is GONE — a single open Concept shows
  // only its concept header, no bar above it.
  await expect(page.locator('nav[aria-label="Global controls"]')).toHaveCount(0);

  // The Properties toggle now lives in the concept header, next to Edit. It
  // starts OFF (default hidden): no Properties chrome in the tile.
  const header = page.getByTestId('tile-header');
  const propsToggle = header.getByTestId('properties-toggle');
  await expect(propsToggle).toBeVisible();
  await expect(propsToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('properties')).toHaveCount(0);
  // Toggling it ON reveals the tile's frontmatter inline; OFF hides it again.
  await propsToggle.click();
  await expect(propsToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('properties')).toBeVisible();
  await propsToggle.click();
  await expect(propsToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('properties')).toHaveCount(0);

  // The sidebar collapse/expand affordances are now each sidebar's edge — a
  // click target that reflects the open state via aria-pressed.
  const leftEdge = page.getByTestId('left-sidebar-edge');
  const rightEdge = page.getByTestId('right-sidebar-edge');
  await expect(leftEdge).toHaveAttribute('aria-pressed', 'true');
  await expect(rightEdge).toHaveAttribute('aria-pressed', 'false');
  // Clicking the left edge collapses the left Sidebar.
  await leftEdge.click();
  await expect(leftEdge).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('side-bar')).not.toBeVisible();
  // Clicking it again re-expands.
  await leftEdge.click();
  await expect(leftEdge).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('side-bar')).toBeVisible();
});
