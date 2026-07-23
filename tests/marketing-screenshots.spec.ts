import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * Ticket: marketing-readme-with-screenshots.
 *
 * Produces the light + dark hero screenshots embedded in the README. These are
 * NOT test artifacts (those live under tests/screenshots/) — they are committed
 * marketing assets, so they are written to docs/assets/.
 *
 * Each shot drives a REAL run of the production build against the fake backend's
 * seeded Bundle: we open a content-rich Concept (live preview with a fenced code
 * block, a GFM table and task list), and expand BOTH sidebars so the Explorer
 * tree, frontmatter Properties, Outline, Tags and Backlinks are all on screen —
 * an attractive, full-featured frame.
 *
 * Theme follows the OS color scheme (theme.svelte.ts), so each mode is driven via
 * the browser context's `colorScheme` and asserted against the app root's
 * `data-theme` before snapping.
 */

const ASSET_DIR = 'docs/assets';

test.beforeAll(() => {
  mkdirSync(ASSET_DIR, { recursive: true });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`marketing screenshot — ${scheme} mode`, async ({ browser }) => {
    const context = await browser.newContext({
      colorScheme: scheme,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    await page.goto('/');

    const tree = page.getByTestId('tree');
    await expect(tree).toBeVisible();
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-theme', scheme);

    // Properties is hidden by default (global toggle); switch it on so the
    // frontmatter panel appears in the marketing shot.
    await page.getByTestId('properties-toggle').click();

    // Expand the right Sidebar (starts collapsed) so Backlinks is on screen.
    const rightToggle = page.getByTestId('right-sidebar-edge');
    const rightAside = page.getByTestId('right-side-bar');
    if ((await rightToggle.getAttribute('aria-pressed')) !== 'true') {
      await rightToggle.click();
    }
    await expect.poll(async () => (await rightAside.boundingBox())?.width).toBeGreaterThan(0);

    // Open a content-rich Concept: live preview renders styled markdown, a
    // fenced code block, a task list and an interactive GFM table.
    await tree.locator('[data-path="concepts/editor/live-preview.md"]').click();
    const editor = page.getByTestId('editor');
    await expect(editor).toBeVisible();
    await expect(editor).toContainText('Obsidian-style hybrid editing');

    // Make sure the supporting panels have populated before we snap.
    await expect(page.getByTestId('properties')).toBeVisible();
    await expect(page.getByTestId('outline')).toBeVisible();

    // Let fonts/syntax-highlight settle for a crisp frame.
    await page.waitForTimeout(400);

    await page.screenshot({ path: `${ASSET_DIR}/screenshot-${scheme}.png`, fullPage: false });

    await context.close();
  });
}
