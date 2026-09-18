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

/**
 * Verification: a link whose LABEL is itself an address (`[a@b.c](mailto:a@b.c)`
 * — the shape an XWiki/Confluence export produces for every mail address) keeps
 * the address as its visible text, and clicking it opens the DESTINATION.
 *
 * GFM autolinking parses that label into a `URL` node of its own, so the Link
 * owns two `URL` children; treating the first as the destination hid the label
 * as link syntax (an empty anchor) and opened the bare address.
 */
test('a link labelled with an email address stays visible and opens its mailto:', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    const orig = window.open.bind(window);
    window.open = ((url?: string | URL, ...rest: unknown[]) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(url));
      return orig(url as string, ...(rest as [string?, string?]));
    }) as typeof window.open;
  });
  await page.goto('/');

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await tree.locator('[data-path="concepts/links-demo.md"]').click();

  const editor = page.getByTestId('editor');
  const link = editor.locator('.cm-atomic-link', { hasText: 'hello@example.com' }).first();

  // The label renders as visible text — the markup around it is what hides.
  await expect(link).toHaveText('hello@example.com');
  await expect(editor).not.toContainText('mailto:hello@example.com');

  const box = await link.boundingBox();
  if (!box) throw new Error('mail link not found');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // The DESTINATION is handed off, not the bare label text.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened))
    .toContain('mailto:hello@example.com');
});
