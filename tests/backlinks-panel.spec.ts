import { test, expect } from '@playwright/test';

/**
 * Expand the right Sidebar (idempotent) so its Backlinks Section is interactable.
 * The right Sidebar starts COLLAPSED (right-sidebar-move-backlinks); expanding it
 * reveals Backlinks, whose own Section defaults to expanded.
 */
async function expandRightSidebar(page: import('@playwright/test').Page) {
  const toggle = page.getByTestId('right-sidebar-edge');
  if ((await toggle.getAttribute('aria-pressed')) === 'false') await toggle.click();
}

/**
 * Slice 7: backlinks panel.
 *
 * Drives the right-hand Backlinks panel against the fake backend:
 *  - opens a Concept that other Concepts link TO (`concepts/codemirror.md`, which
 *    is linked from `concepts/bundle.md`, `concepts/links-demo.md`, and
 *    `concepts/index.md` + `concepts/editor/live-preview.md`);
 *  - asserts the backlinks are listed;
 *  - clicks a backlink and asserts that source Concept opens (and that opening
 *    participates in nav history — Back returns to the original);
 *  - asserts the empty state for a Concept nothing links to.
 */
test('backlinks panel lists sources and opens them via navigation', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // Backlinks lives in the collapsed-by-default right Sidebar; expand it to read.
  await expandRightSidebar(page);
  const backlinks = page.getByTestId('backlinks');
  await expect(backlinks).toBeVisible();

  // Open a Concept that several others link TO.
  await tree.locator('[data-path="concepts/codemirror.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('CodeMirror 6 is the editor core');

  // Backlinks are listed: bundle.md and links-demo.md (and more) link here.
  const entries = backlinks.getByTestId('backlink');
  await expect(entries).toHaveCount(4);
  await expect(backlinks.locator('[data-path="concepts/bundle.md"]')).toBeVisible();
  await expect(backlinks.locator('[data-path="concepts/links-demo.md"]')).toBeVisible();

  await page.screenshot({ path: 'tests/screenshots/backlinks-panel.png', fullPage: true });

  // Clicking a backlink opens that source Concept (through navigation history).
  await backlinks.locator('[data-path="concepts/bundle.md"]').click();
  await expect(editor).toContainText('A Bundle is the root folder');

  // It pushed history: Back returns to the originally-focused Concept.
  await page.getByTestId('nav-back').click();
  await expect(editor).toContainText('CodeMirror 6 is the editor core');

  // Empty state: a Concept nothing links to shows "No backlinks".
  await tree.locator('[data-path="concepts/complex-frontmatter.md"]').click();
  await expect(editor).toContainText('This Concept has nested');
  await expect(backlinks.getByTestId('backlinks-empty')).toHaveText('No backlinks');
});

test('backlinks panel refreshes when links change on disk', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();

  await expandRightSidebar(page);
  const backlinks = page.getByTestId('backlinks');

  // complex-frontmatter.md initially has no backlinks.
  await page.getByTestId('tree').locator('[data-path="concepts/complex-frontmatter.md"]').click();
  await expect(backlinks.getByTestId('backlinks-empty')).toHaveText('No backlinks');

  // Simulate another tool editing bundle.md to add a link to complex-frontmatter.
  await page.evaluate(() => {
    const fake = (
      window as unknown as {
        __sunstoneFake: {
          simulateExternalChange: (kind: string, path: string, content?: string) => void;
          files: Record<string, string>;
        };
      }
    ).__sunstoneFake;
    const updated =
      fake.files['concepts/bundle.md'] +
      '\n\nNow links to [Complex](./complex-frontmatter.md).\n';
    fake.simulateExternalChange('modified', 'concepts/bundle.md', updated);
  });

  // The panel re-queries on the index version bump and now lists bundle.md.
  await expect(backlinks.locator('[data-path="concepts/bundle.md"]')).toBeVisible();
});
