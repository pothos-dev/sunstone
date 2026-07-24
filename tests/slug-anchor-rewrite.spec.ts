import { test, expect, type Page } from '@playwright/test';

/**
 * Slice: slug-anchor-rewrite.
 *
 * Two behaviours, end-to-end over the fake backend:
 *
 *  1. Anchors resolve GitHub-style by SLUG: `[[target#deep-section]]` navigates
 *     to and scrolls to a `## Deep Section` heading.
 *  2. Renaming a heading in the editor rewrites the anchors that point at it —
 *     inbound `[[target#old]]` / `[text](/target.md#old)` in OTHER files (via the
 *     backend) AND same-file `[[#old]]` in the open buffer — to the new slug.
 *     Deleting a heading instead leaves its inbound anchors alone (they break,
 *     they are NOT silently repointed to another heading).
 *
 * Fixtures are seeded at RUNTIME via the fake watcher hook (as in
 * wikilinks.spec.ts / link-auto-rewrite.spec.ts) so the shared Explorer fixture
 * other specs screenshot stays untouched.
 */

type FakeWindow = Window & {
  __sunstoneFake: {
    simulateExternalChange: (kind: string, path: string, content?: string) => void;
    files: Record<string, string>;
  };
};

const fm = (title: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n`;

async function createConcept(page: Page, path: string, body: string): Promise<void> {
  await page.evaluate(
    ([p, b]) => {
      (window as unknown as FakeWindow).__sunstoneFake.simulateExternalChange('created', p, b);
    },
    [path, body] as const,
  );
}

function fileContent(page: Page, path: string): Promise<string> {
  return page.evaluate(
    (p) => (window as unknown as FakeWindow).__sunstoneFake.files[p],
    path,
  );
}

async function clickWikiLink(page: Page, target: string, text: string): Promise<void> {
  const link = page
    .getByTestId('editor')
    .locator(`[data-wiki-link-target="${target}"]`, { hasText: text })
    .first();
  await expect(link).toBeVisible();
  await link.click();
}

test('anchors resolve GitHub-style by slug when navigating', async ({ page }) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  await createConcept(
    page,
    'sl-target.md',
    `${fm('SL Target')}# SL Target\n\nIntro.\n\n## Deep Section\n\nDeep body line.\n`,
  );
  // The source links by SLUG (`deep-section`), not by the literal heading text.
  await createConcept(
    page,
    'sl-source.md',
    `${fm('SL Source')}# SL Source\n\nJump to [[sl-target#deep-section]] now.\n`,
  );

  await tree.locator('[data-path="sl-source.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('SL Source');

  // Clicking the slug-anchored wikilink opens the target and scrolls the heading
  // into view — proving the anchor matched the heading by its GitHub slug.
  await clickWikiLink(page, 'sl-target#deep-section', 'sl-target');
  await expect(editor).toContainText('Deep body line.');
  await expect(tree.locator('[data-path="sl-target.md"]')).toHaveClass(/selected/);
  await expect(editor.locator('.cm-line', { hasText: 'Deep Section' }).first()).toBeInViewport();
});

test('renaming a heading rewrites inbound + same-file anchors to the new slug', async ({
  page,
}) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // Target has the heading, plus a SAME-FILE anchor to it (`[[#deep-section]]`).
  await createConcept(
    page,
    'rw-target.md',
    `${fm('RW Target')}# RW Target\n\n## Deep Section\n\nBody.\n\nBack to [[#deep-section]].\n`,
  );
  // Source links to the heading two ways: a wikilink and a markdown link.
  await createConcept(
    page,
    'rw-source.md',
    `${fm('RW Source')}# RW Source\n\n` +
      `Wiki [[rw-target#deep-section]] and md [go](/rw-target.md#deep-section).\n`,
  );

  await tree.locator('[data-path="rw-target.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('RW Target');

  // Read is the default; enter editing so the heading can be renamed in the buffer.
  await page.getByTestId('edit-toggle').click();

  // Rename the heading `## Deep Section` -> `## Deep Sectioner` (slug becomes
  // `deep-sectioner`) by appending to it in the editor.
  const headingLine = editor.locator('.cm-line', { hasText: 'Deep Section' }).first();
  await headingLine.click();
  await page.keyboard.press('End');
  await page.keyboard.type('er');

  // Cross-file: the source's wikilink AND markdown-link anchors follow the slug.
  await expect
    .poll(() => fileContent(page, 'rw-source.md'))
    .toContain('[[rw-target#deep-sectioner]]');
  expect(await fileContent(page, 'rw-source.md')).toContain('/rw-target.md#deep-sectioner');

  // Same-file: the target's own `[[#deep-section]]` was rewritten in the buffer
  // and persisted, and the heading text itself now reads "Deep Sectioner".
  await expect
    .poll(() => fileContent(page, 'rw-target.md'))
    .toContain('[[#deep-sectioner]]');
  expect(await fileContent(page, 'rw-target.md')).toContain('## Deep Sectioner');

  // The unobtrusive rewrite toast confirms the cross-file update.
  await expect(page.getByTestId('rewrite-toast')).toBeVisible();
});

test('deleting a heading leaves inbound anchors broken, not repointed', async ({ page }) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // Two headings: if we (wrongly) diffed by position, deleting the first could
  // repoint its anchor onto the second. Identity tracking must NOT do that.
  await createConcept(
    page,
    'del-target.md',
    `${fm('Del Target')}# Del Target\n\n## Deep Section\n\nBody.\n\n## Other Heading\n\nMore.\n`,
  );
  await createConcept(
    page,
    'del-source.md',
    `${fm('Del Source')}# Del Source\n\nLink [[del-target#deep-section]].\n`,
  );

  await tree.locator('[data-path="del-target.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('Del Target');

  // Read is the default; enter editing so the heading text can be deleted.
  await page.getByTestId('edit-toggle').click();

  // Delete the `## Deep Section` heading's text (its identity is dropped).
  const headingLine = editor.locator('.cm-line', { hasText: 'Deep Section' }).first();
  await headingLine.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.press('Delete');

  // Let autosave + any rewrite settle, then confirm the inbound anchor is
  // UNCHANGED — not repointed to `#other-heading`.
  await expect
    .poll(() => fileContent(page, 'del-target.md'))
    .not.toContain('## Deep Section');
  const source = await fileContent(page, 'del-source.md');
  expect(source).toContain('[[del-target#deep-section]]');
  expect(source).not.toContain('other-heading');
});
