import { test, expect } from './fixtures';
import { type Page } from '@playwright/test';

/**
 * A markdown link that points at a FOLDER opens that folder's `index.md`
 * (instead of failing to read a directory). The broken-link decoration agrees:
 * such a link is not marked broken. A link to the Bundle root (`/`) opens the
 * root `index.md`.
 */

type FakeWindow = Window & {
  __sunstoneFake: {
    simulateExternalChange: (kind: string, path: string, content?: string) => void;
  };
};

async function createConcept(page: Page, path: string, body: string): Promise<void> {
  await page.waitForFunction(() => '__sunstoneFake' in window);
  await page.evaluate(
    ([p, b]) => {
      (window as unknown as FakeWindow).__sunstoneFake.simulateExternalChange('created', p, b);
    },
    [path, body] as const,
  );
}

/** Click the trailing "open" icon hit-zone of a rendered live-preview link. */
async function clickLink(page: Page, label: string): Promise<void> {
  const link = page.getByTestId('editor').locator('.cm-atomic-link', { hasText: label }).first();
  const box = await link.boundingBox();
  if (!box) throw new Error(`link not found: ${label}`);
  await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
}

test('a link to a folder opens its index.md', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();

  await createConcept(
    page,
    'hub.md',
    '---\ntype: concept\ntitle: Hub\n---\n\n# Hub\n\nSee [the concepts folder](./concepts/) for more.\n',
  );
  await page.getByTestId('tree').locator('[data-path="hub.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('See the concepts folder');
  const link = editor.locator('.cm-atomic-link', { hasText: 'the concepts folder' }).first();
  await expect(link).not.toHaveClass(/broken/);

  await clickLink(page, 'the concepts folder');
  // concepts/index.md lists its children.
  await expect(editor).toContainText('Live preview');
  await expect(editor).not.toContainText('See the concepts folder');
});

test('a link to the Bundle root opens the root index.md', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('tree')).toBeVisible();

  await createConcept(
    page,
    'hub.md',
    '---\ntype: concept\ntitle: Hub\n---\n\n# Hub\n\nBack to [the start page](/) from here.\n',
  );
  await page.getByTestId('tree').locator('[data-path="hub.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('Back to the start page');
  await clickLink(page, 'the start page');
  await expect(editor).toContainText('reserved');
  await expect(page.locator('[data-reserved-path="index.md"]')).toHaveClass(/selected/);
});
