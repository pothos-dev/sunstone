import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';

/**
 * Slice: bundle-index-broken-links.
 *
 * Drives the broken-link styling (the index's first consumer) and the index
 * query surface, all against the fake backend (which computes over its in-memory
 * fixture, mirroring the Rust index):
 *  - opens `concepts/links-demo.md`, which links to existing AND non-existent
 *    Concepts; asserts broken links get `.cm-broken-link` and existing ones do
 *    not, while staying clickable (navigation still works → never blocked);
 *  - asserts the backlinks / tags / types queries return expected data via the
 *    fake backend, evaluated in the page (the seam the next slices consume).
 */

/** Run a Backend query in the page against the active (fake) backend. */
async function queryBackend<T>(
  page: Page,
  method: 'backlinks' | 'allTags' | 'allTypes' | 'listConceptPaths',
  arg?: string,
): Promise<T> {
  return page.evaluate(
    async ({ method, arg }) => {
      // The active backend is exposed on `window.__sunstoneBackend` by
      // src/lib/ipc/index.ts as a stable test hook. Reading it from the window
      // (rather than dynamically importing `/src/...`) works against both the
      // dev server and a precompiled production build.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const backend = (window as any).__sunstoneBackend;
      return arg !== undefined ? backend[method](arg) : backend[method]();
    },
    { method, arg },
  );
}

test('broken internal links render distinct but stay clickable', async ({ page }) => {
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  await tree.locator('[data-path="concepts/links-demo.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('Working links resolve to real Concepts');

  // The two broken links (./ghost.md, /does-not-exist.md) are styled distinctly.
  const broken = editor.locator('.cm-broken-link');
  await expect(broken).toHaveCount(2);
  await expect(broken.filter({ hasText: 'Ghost Concept' })).toBeVisible();
  await expect(broken.filter({ hasText: 'Missing Page' })).toBeVisible();

  // The styling is actually distinct (dashed red), proving it's not just normal.
  const decoration = await broken
    .first()
    .evaluate((el) => getComputedStyle(el).textDecorationStyle);
  expect(decoration).toBe('dashed');

  // Existing-target links are NOT marked broken.
  await expect(
    editor.locator('.cm-atomic-link', { hasText: 'CodeMirror' }).locator('.cm-broken-link'),
  ).toHaveCount(0);
  // Sanity: "CodeMirror" link text exists in the editor but is not broken.
  await expect(editor.locator('.cm-broken-link', { hasText: 'CodeMirror' })).toHaveCount(0);

  await page.screenshot({
    path: 'tests/screenshots/bundle-index.png',
    fullPage: true,
  });

  // Broken links remain CLICKABLE and navigable (never blocked). Clicking the
  // trailing open-icon hit zone navigates; the missing Concept opens in a
  // graceful not-found state (the editor's #load tolerates the read error).
  const ghost = editor.locator('.cm-atomic-link', { hasText: 'Ghost Concept' }).first();
  const box = await ghost.boundingBox();
  if (!box) throw new Error('broken link not found');
  await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
  // It selected the (missing) target in the tree path state without crashing.
  await expect(editor).toBeVisible();
});

test('index queries (backlinks / tags / types) via the fake backend', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();

  // Backlinks: both `concepts/bundle.md` and `concepts/links-demo.md` link to
  // `concepts/codemirror.md`, so it has two backlinks.
  const cmBacklinks = await queryBackend<string[]>(page, 'backlinks', 'concepts/codemirror.md');
  expect(cmBacklinks).toEqual(
    expect.arrayContaining(['concepts/bundle.md', 'concepts/links-demo.md']),
  );

  // `index.md` is linked by the bundle-absolute link in links-demo + bundle.md.
  const indexBacklinks = await queryBackend<string[]>(page, 'backlinks', 'index.md');
  expect(indexBacklinks).toEqual(
    expect.arrayContaining(['concepts/bundle.md', 'concepts/links-demo.md']),
  );

  // A non-existent target still answers (no crash), with whatever links to it.
  const ghostBacklinks = await queryBackend<string[]>(page, 'backlinks', 'concepts/ghost.md');
  expect(ghostBacklinks).toContain('concepts/links-demo.md');

  // Tags aggregate with counts; `okf` appears on several Concepts.
  const tags = await queryBackend<Array<{ tag: string; count: number }>>(page, 'allTags');
  const okf = tags.find((t) => t.tag === 'okf');
  expect(okf).toBeDefined();
  expect(okf!.count).toBeGreaterThanOrEqual(3);
  expect(tags.find((t) => t.tag === 'links')).toBeDefined();

  // Types are distinct + sorted; the fixture has concept/index/log.
  const types = await queryBackend<string[]>(page, 'allTypes');
  expect(types).toEqual(expect.arrayContaining(['concept', 'index', 'log']));

  // listConceptPaths includes the demo Concept (the seam the broken-link cache
  // is seeded from).
  const paths = await queryBackend<string[]>(page, 'listConceptPaths');
  expect(paths).toContain('concepts/links-demo.md');
});
