import { test, expect, type Page } from './fixtures';

/**
 * Ticket ov-7: the user sets the Bundle root explicitly.
 *
 * Against the fake backend (opened at its repository toplevel, root `index.md`
 * at the top): mark `concepts/` as the Bundle root from the Explorer's folder
 * menu, follow a bundle-absolute link that now resolves under it, survive a
 * reload (the override is per-Bundle View state), then clear it back to
 * automatic detection. The Explorer header shows the root throughout, and an
 * override looks different from a detected root. The Bundle itself is never
 * written.
 */

async function rowMenuAction(page: Page, row: string, action: string): Promise<void> {
  await page.getByTestId('tree').locator(`[data-row-path="${row}"]`).click({ button: 'right' });
  const menu = page.getByTestId('context-menu');
  await expect(menu).toBeVisible();
  await menu.locator(`[data-action="${action}"]`).click();
  await expect(menu).toBeHidden();
}

/** Click the `Knowledge Base` link (`/index.md`) in `concepts/bundle.md`. */
async function followKnowledgeBase(page: Page): Promise<void> {
  await page.getByTestId('tree').locator('[data-path="concepts/bundle.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('A Bundle is the root folder');
  const link = editor.locator('.cm-atomic-link', { hasText: 'Knowledge Base' }).first();
  const box = await link.boundingBox();
  if (!box) throw new Error('Knowledge Base link not found');
  // The trailing "open" icon at the link's right edge navigates (live preview).
  await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
}

/** Every Concept path and the root index's text: the Bundle as the backend holds it. */
async function bundleOnDisk(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const backend = (
      window as unknown as {
        __sunstoneBackend: {
          listConceptPaths(): Promise<string[]>;
          readConcept(path: string): Promise<string>;
        };
      }
    ).__sunstoneBackend;
    return { paths: await backend.listConceptPaths(), index: await backend.readConcept('index.md') };
  });
}

test('set the Bundle root on a folder, follow a /link under it, persist, and clear it', async ({
  page,
}) => {
  await page.goto('/');
  const root = page.getByTestId('bundle-root');
  const title = page.getByTestId('tile-title');

  // Detected: the fake's root `index.md` roots the Bundle at the opened folder.
  await expect(root).toHaveText('/');
  await expect(root).toHaveAttribute('data-overridden', 'false');
  await expect(root).toHaveAttribute('title', /detected/);
  const before = await bundleOnDisk(page);

  // Override: `concepts/` becomes the root; the header says so, distinctly.
  await rowMenuAction(page, 'concepts', 'setBundleRoot');
  await expect(root).toHaveText('/concepts');
  await expect(root).toHaveAttribute('data-overridden', 'true');
  await expect(root).toHaveAttribute('title', /set by you/);

  // `/index.md` now resolves under the chosen root.
  await followKnowledgeBase(page);
  await expect(title).toHaveAttribute('title', 'concepts/index.md');

  // The choice survives a restart and the Bundle is untouched.
  await page.reload();
  await expect(root).toHaveText('/concepts');
  await expect(root).toHaveAttribute('data-overridden', 'true');
  expect(await bundleOnDisk(page)).toEqual(before);

  // The override folder offers only to clear; clearing returns to detection,
  // and the open link re-resolves without a reload.
  await page.getByTestId('tree').locator('[data-row-path="concepts"]').click({ button: 'right' });
  const menu = page.getByTestId('context-menu');
  await expect(menu.locator('[data-action="setBundleRoot"]')).toHaveCount(0);
  await menu.locator('[data-action="clearBundleRoot"]').click();
  await expect(root).toHaveText('/');
  await expect(root).toHaveAttribute('data-overridden', 'false');

  await followKnowledgeBase(page);
  await expect(title).toHaveAttribute('title', 'index.md');
  expect(await bundleOnDisk(page)).toEqual(before);
});
