import { test, expect } from './fixtures';

/**
 * Ticket: reskin-to-sunstone-palette.
 *
 * Captures a light + dark screenshot of the app after the warm sunstone retheme
 * for visual review. Theme follows the OS color scheme (see theme.svelte.ts), so
 * we drive each mode via the browser context's `colorScheme` and assert the app
 * root carries the matching `data-theme` before snapping.
 */

for (const scheme of ['light', 'dark'] as const) {
  test(`sunstone palette renders in ${scheme} mode`, async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: scheme });
    const page = await context.newPage();

    await page.goto('/');

    const tree = page.getByTestId('tree');
    await expect(tree).toBeVisible();
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-theme', scheme);

    // Open a Concept so the editor (CodeMirror) is on screen too — this is where
    // the atomic-editor accent/link/selection tokens must re-resolve to the warm
    // amber accent rather than the library's default purple.
    await tree.locator('[data-path="concepts/codemirror.md"]').click();
    const editor = page.getByTestId('editor');
    await expect(editor).toBeVisible();
    await expect(editor).toContainText('CodeMirror 6 is the editor core');

    await page.screenshot({ path: `tests/screenshots/sunstone-${scheme}.png`, fullPage: true });

    await context.close();
  });
}
