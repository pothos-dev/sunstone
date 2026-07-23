import { test, expect } from './fixtures';

/**
 * Verification: clicking an EXTERNAL (scheme) link opens it in the default
 * browser rather than navigating the Tile in-app. The click routes through the
 * `backend.openExternal` seam; the fake backend (running under a real browser)
 * implements that as `window.open`, so we spy on it and assert the URL — and
 * assert the Tile did NOT navigate away from the source Concept.
 */
test('clicking an external link opens it externally, not in-app', async ({ page }) => {
  await page.goto('/');

  // Capture every window.open call (the fake backend's openExternal).
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    const orig = window.open.bind(window);
    window.open = ((url?: string | URL, ...rest: unknown[]) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(url));
      return orig(url as string, ...(rest as [string?, string?]));
    }) as typeof window.open;
  });
  await page.reload();

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await tree.locator('[data-path="concepts/links-demo.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('An external link is never treated as broken');

  // Read (the default) makes the whole link clickable (parity with the read-mode spec).
  await expect(page.getByTestId('edit-toggle')).toHaveAttribute('aria-pressed', 'false');

  const link = editor.locator('.cm-atomic-link', { hasText: 'Example' }).first();
  const box = await link.boundingBox();
  if (!box) throw new Error('external link not found');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // The external URL was handed off to the OS/browser…
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened))
    .toContain('https://example.com');

  // …and the Tile stayed on the source Concept (no in-app navigation).
  await expect(editor).toContainText('An external link is never treated as broken');
  await expect(page.locator('[data-path="concepts/links-demo.md"]')).toHaveClass(/selected/);
});
