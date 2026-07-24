import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * Slice: criticmarkup-annotations (feat/criticmarkup-annotations) — the editor's
 * right-click formatting menu.
 *
 * The same right-click menu that offers "Add/Remove comment" also offers the
 * standard markdown formatting actions. These specs drive that menu over the
 * fake backend (mirroring critic-annotations.spec.ts): create a Concept, select
 * a word with the keyboard, then open the menu WITHOUT collapsing the selection
 * via a synthetic `contextmenu` event, and assert against the fake source in
 * `window.__sunstoneFake.files[...]`.
 */

type FakeWindow = Window & {
  __sunstoneFake: {
    simulateExternalChange: (kind: string, path: string, content?: string) => void;
    files: Record<string, string>;
  };
};

const fm = (title: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n`;

/** Create a Concept at a bundle-relative path via the fake watcher hook. */
async function createConcept(page: Page, path: string, body: string): Promise<void> {
  // The fake backend installs `__sunstoneFake` during app boot; wait for it so a
  // create issued right after navigation doesn't race initialization.
  await page.waitForFunction(() => '__sunstoneFake' in window);
  await page.evaluate(
    ([p, b]) => {
      (window as unknown as FakeWindow).__sunstoneFake.simulateExternalChange('created', p, b);
    },
    [path, body] as const,
  );
}

/** Open the given Concept and select its leading word "Highlightme" (11 chars). */
async function openAndSelectWord(page: Page, path: string): Promise<void> {
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await expect(tree.locator(`[data-path="${path}"]`)).toBeVisible();
  await tree.locator(`[data-path="${path}"]`).click();

  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('Highlightme is the word');

  // Read is the default; enter editing so the keyboard selection + formatting
  // context menu (both editable-only) are available.
  await page.getByTestId('edit-toggle').click();

  const para = editor.locator('.cm-line', { hasText: 'Highlightme' }).first();
  await para.click();
  await page.keyboard.press('Home');
  for (let i = 0; i < 11; i++) await page.keyboard.press('Shift+ArrowRight');
}

test('formatting menu: "Bold" wraps the selection as **word**', async ({ page }) => {
  await page.goto('/');
  await createConcept(
    page,
    'fmt-bold.md',
    `${fm('Bold')}# Bold\n\nHighlightme is the word to format.\n`,
  );
  await openAndSelectWord(page, 'fmt-bold.md');

  const editor = page.getByTestId('editor');
  // Synthetic contextmenu preserves the selection (a real right-click could
  // collapse it to the click point).
  await editor.dispatchEvent('contextmenu', { clientX: 200, clientY: 200 });

  const menu = page.getByTestId('context-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-action="bold"]')).toHaveText('Bold');
  await menu.locator('[data-action="bold"]').click();

  await expect(menu).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as FakeWindow).__sunstoneFake.files['fmt-bold.md']),
    )
    .toContain('**Highlightme**');
});

test('formatting menu: "Insert link" wraps the selection as [word]()', async ({ page }) => {
  await page.goto('/');
  await createConcept(
    page,
    'fmt-link.md',
    `${fm('Link')}# Link\n\nHighlightme is the word to link.\n`,
  );
  await openAndSelectWord(page, 'fmt-link.md');

  const editor = page.getByTestId('editor');
  await editor.dispatchEvent('contextmenu', { clientX: 200, clientY: 200 });

  const menu = page.getByTestId('context-menu');
  await expect(menu).toBeVisible();
  // No link under the caret yet → the item reads "Insert link".
  await expect(menu.locator('[data-action="link"]')).toHaveText('Insert link');
  await menu.locator('[data-action="link"]').click();

  await expect(menu).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as FakeWindow).__sunstoneFake.files['fmt-link.md']),
    )
    .toContain('[Highlightme]()');
});

test('formatting menu: label reads "Edit link" when the caret is inside a link', async ({
  page,
}) => {
  await page.goto('/');
  await createConcept(
    page,
    'fmt-editlink.md',
    `${fm('Edit Link')}# Edit Link\n\n[Highlightme](http://example.com) is the word.\n`,
  );

  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await expect(tree.locator('[data-path="fmt-editlink.md"]')).toBeVisible();
  await tree.locator('[data-path="fmt-editlink.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('Highlightme');

  // Read is the default; enter editing so the formatting context menu is offered.
  await page.getByTestId('edit-toggle').click();

  // Place the caret at the start of the link line (inside the link span).
  const para = editor.locator('.cm-line', { hasText: 'Highlightme' }).first();
  await para.click();
  await page.keyboard.press('Home');

  await editor.dispatchEvent('contextmenu', { clientX: 200, clientY: 200 });

  const menu = page.getByTestId('context-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-action="link"]')).toHaveText('Edit link');
});

// Clipboard actions run over the web Clipboard API, which needs granted
// permissions in Chromium.
test.describe('clipboard', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('formatting menu: "Copy" writes the selection to the clipboard', async ({ page }) => {
    await page.goto('/');
    await createConcept(
      page,
      'clip-copy.md',
      `${fm('Copy')}# Copy\n\nHighlightme is the word to copy.\n`,
    );
    await openAndSelectWord(page, 'clip-copy.md');

    const editor = page.getByTestId('editor');
    await editor.dispatchEvent('contextmenu', { clientX: 200, clientY: 200 });

    const menu = page.getByTestId('context-menu');
    await expect(menu).toBeVisible();
    await menu.locator('[data-action="copy"]').click();
    await expect(menu).toHaveCount(0);

    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe('Highlightme');
  });

  test('formatting menu: "Paste" inserts the clipboard text at the caret', async ({ page }) => {
    await page.goto('/');
    await createConcept(page, 'clip-paste.md', `${fm('Paste')}# Paste\n\nBefore after.\n`);

    const tree = page.getByTestId('tree');
    await expect(tree.locator('[data-path="clip-paste.md"]')).toBeVisible();
    await tree.locator('[data-path="clip-paste.md"]').click();

    const editor = page.getByTestId('editor');
    await expect(editor).toBeVisible();
    await expect(editor).toContainText('Before after.');

    // Read is the default; enter editing so the formatting context menu is
    // offered and Paste can insert into the body.
    await page.getByTestId('edit-toggle').click();

    // Seed the clipboard, then park the caret at the start of the text line.
    await page.evaluate(() => navigator.clipboard.writeText('PASTED '));
    const para = editor.locator('.cm-line', { hasText: 'Before after.' }).first();
    await para.click();
    await page.keyboard.press('Home');

    await editor.dispatchEvent('contextmenu', { clientX: 200, clientY: 200 });
    const menu = page.getByTestId('context-menu');
    await expect(menu).toBeVisible();
    await menu.locator('[data-action="paste"]').click();
    await expect(menu).toHaveCount(0);

    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as FakeWindow).__sunstoneFake.files['clip-paste.md']),
      )
      .toContain('PASTED Before after.');
  });
});
