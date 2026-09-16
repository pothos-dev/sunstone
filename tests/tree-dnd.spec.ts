import { test, expect } from './fixtures';

/**
 * Slice: tree-dnd.
 *
 * Drag-and-drop moving of Concepts (and folders) in the document tree, against
 * the fake backend. Dragging a row onto a folder row moves it INTO that folder;
 * dropping onto empty tree space moves it to the Bundle root. This is an
 * alternate UI path to the same `treeActions.movePath` the "Move…" menu uses,
 * so the editor still follows the move and links still auto-rewrite.
 */

test('tree DnD: drag a Concept into a folder, then back out to the root', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // The seed tree has `concepts/codemirror.md` and a `concepts/editor` folder,
  // both visible (default-open folders). Drag the Concept onto the folder row.
  const source = tree.locator('[data-row-path="concepts/codemirror.md"]');
  const editorFolder = tree.locator('[data-row-path="concepts/editor"]');
  await expect(source).toBeVisible();
  await expect(editorFolder).toBeVisible();

  await source.dragTo(editorFolder);

  const moved = 'concepts/editor/codemirror.md';
  await expect(tree.locator('[data-path="concepts/codemirror.md"]')).toHaveCount(0);
  await expect(tree.locator(`[data-path="${moved}"]`)).toBeVisible();

  await page.screenshot({ path: 'tests/screenshots/tree-dnd.png', fullPage: true });

  // Drag it back out onto empty tree-tile space (below the rows) → moves to the
  // Bundle root. The "+ New…" affordance sits in that empty area and bubbles its
  // drag events up to the tile's root drop zone.
  await tree
    .locator(`[data-row-path="${moved}"]`)
    .dragTo(page.getByTestId('root-new-concept'));
  await expect(tree.locator(`[data-path="${moved}"]`)).toHaveCount(0);
  await expect(tree.locator('[data-path="codemirror.md"]')).toBeVisible();
});

test('tree DnD: a folder cannot be dropped into its own descendant', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  const parent = tree.locator('[data-row-path="concepts"]');
  const child = tree.locator('[data-row-path="concepts/editor"]');
  await expect(parent).toBeVisible();
  await expect(child).toBeVisible();

  // Illegal: `canDrop` rejects dropping a folder into its own subtree, so the
  // structure is unchanged and `concepts` still lives at the root.
  await parent.dragTo(child);
  await expect(tree.locator('[data-row-path="concepts"]')).toHaveCount(1);
  await expect(tree.locator('[data-row-path="concepts/editor"]')).toHaveCount(1);
  await expect(tree.locator('[data-row-path="concepts/editor/concepts"]')).toHaveCount(0);
});
