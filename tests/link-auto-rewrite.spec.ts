import { test, expect, type Page } from '@playwright/test';

/**
 * Slice: link-auto-rewrite.
 *
 * When a Concept is moved, links must stay valid — two-directional and
 * path-aware. This drives the fake backend (faithful port of the Rust path
 * math) through the real move UI and asserts:
 *
 *  - an INBOUND ABSOLUTE link (A -> B via `/sub2/b.md`) becomes the new absolute
 *    path after B moves;
 *  - an INBOUND RELATIVE link from a DIFFERENT directory (C in sub/ -> B via
 *    `../sub2/b.md`) is recomputed relative to C's own dir and still resolves;
 *  - the moved Concept's OWN RELATIVE outbound link (B -> D via `./d.md`) is
 *    recomputed from B's new dir and still resolves to D;
 *  - external/unrelated links are untouched;
 *  - the user sees a summary toast of how many links/files changed.
 */

type FakeWindow = Window & {
  __sunstoneFake: {
    simulateExternalChange: (kind: string, path: string, content?: string) => void;
    files: Record<string, string>;
  };
};

/** Seed the scenario Concepts via the fake watcher hook. */
async function seed(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fake = (window as unknown as FakeWindow).__sunstoneFake;
    const fm = (title: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n`;
    // A: inbound ABSOLUTE link to B (in sub2/) + an external link to leave alone.
    fake.simulateExternalChange(
      'created',
      'a.md',
      `${fm('A')}Link to [B](/sub2/b.md) and an [Example](https://example.com).\n`,
    );
    // C (in sub/): inbound RELATIVE link to B from a DIFFERENT directory.
    fake.simulateExternalChange(
      'created',
      'sub/c.md',
      `${fm('C')}Relative link to [B](../sub2/b.md).\n`,
    );
    // B (in sub2/): own RELATIVE outbound to D + an external link to leave alone.
    fake.simulateExternalChange(
      'created',
      'sub2/b.md',
      `${fm('B')}Out to [D](./d.md) and [Org](https://example.org).\n`,
    );
    // D (in sub2/): the target of B's own outbound link.
    fake.simulateExternalChange('created', 'sub2/d.md', `${fm('D')}# D\n`);
  });
}

/** Expand a top-level folder in the tree by its name (click the dir toggle). */
async function expandFolder(page: Page, name: string): Promise<void> {
  const tree = page.getByTestId('tree');
  await tree.locator('button.dir-toggle', { hasText: name }).first().click();
}

/** Open the context menu for a tree node by right-clicking its row. */
async function openRowMenu(page: Page, path: string): Promise<void> {
  const tree = page.getByTestId('tree');
  await tree.locator(`[data-row-path="${path}"]`).click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
}

/**
 * Expand the right Sidebar (idempotent) so its Backlinks Section is interactable.
 * Backlinks moved into the collapsed-by-default right Sidebar
 * (right-sidebar-move-backlinks).
 */
async function expandRightSidebar(page: Page): Promise<void> {
  const toggle = page.getByTestId('right-sidebar-edge');
  if ((await toggle.getAttribute('aria-pressed')) === 'false') await toggle.click();
}

test('link auto-rewrite: inbound + own-outbound links follow a moved Concept', async ({
  page,
}) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  await seed(page);
  // The seeded folders should appear; expand sub2 to reveal B.
  await expect(tree.locator('button.dir-toggle', { hasText: 'sub2' })).toBeVisible();
  await expandFolder(page, 'sub2');
  await expect(tree.locator('[data-path="sub2/b.md"]')).toBeVisible();

  // Move B (sub2/b.md) into the existing `concepts/` folder.
  await openRowMenu(page, 'sub2/b.md');
  await page.getByTestId('context-menu').locator('[data-action="move"]').click();
  await page.getByTestId('dialog-move-target').selectOption('concepts');
  await page.getByTestId('dialog-confirm').click();

  const moved = 'concepts/b.md';
  await expect(tree.locator(`[data-path="${moved}"]`)).toBeVisible();
  await expect(tree.locator('[data-path="sub2/b.md"]')).toHaveCount(0);

  // Inspect the rewritten on-disk content via the fake's file map.
  const files = await page.evaluate(
    () => (window as unknown as FakeWindow).__sunstoneFake.files,
  );

  // A's INBOUND ABSOLUTE link now points at the new absolute path.
  expect(files['a.md']).toContain('[B](/concepts/b.md)');
  // A's external link is untouched.
  expect(files['a.md']).toContain('[Example](https://example.com)');

  // C's INBOUND RELATIVE link (from sub/) is recomputed to still resolve to B.
  // From sub/ to concepts/b.md => ../concepts/b.md.
  expect(files['sub/c.md']).toContain('[B](../concepts/b.md)');

  // B's OWN RELATIVE outbound to D is recomputed from concepts/ to sub2/d.md.
  expect(files['concepts/b.md']).toContain('[D](../sub2/d.md)');
  // B's external link is untouched.
  expect(files['concepts/b.md']).toContain('[Org](https://example.org)');

  // The summary toast reports the change (3 links in 3 files: A, C, B).
  const toast = page.getByTestId('rewrite-toast');
  await expect(toast).toBeVisible();
  await expect(toast).toHaveText('Updated 3 links in 3 files');

  await page.screenshot({ path: 'tests/screenshots/link-auto-rewrite.png', fullPage: true });
});

test('link auto-rewrite: rewritten links still resolve to the moved Concept', async ({
  page,
}) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await seed(page);
  await expect(tree.locator('button.dir-toggle', { hasText: 'sub2' })).toBeVisible();
  await expandFolder(page, 'sub2');
  await expect(tree.locator('[data-path="sub2/b.md"]')).toBeVisible();

  await openRowMenu(page, 'sub2/b.md');
  await page.getByTestId('context-menu').locator('[data-action="move"]').click();
  await page.getByTestId('dialog-move-target').selectOption('concepts');
  await page.getByTestId('dialog-confirm').click();
  await expect(tree.locator('[data-path="concepts/b.md"]')).toBeVisible();

  // Open the moved Concept; the Backlinks panel (driven by the index's reverse
  // map over resolveLink) must list BOTH inbound sources — proof the rewritten
  // absolute (A) and relative (C) links still resolve to B at its new location.
  await tree.locator('[data-path="concepts/b.md"]').click();
  await expandRightSidebar(page);
  const backlinks = page.getByTestId('backlinks');
  await expect(backlinks.locator('[data-testid="backlink"][data-path="a.md"]')).toBeVisible();
  await expect(
    backlinks.locator('[data-testid="backlink"][data-path="sub/c.md"]'),
  ).toBeVisible();
});
