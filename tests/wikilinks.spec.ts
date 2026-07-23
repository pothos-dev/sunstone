import { test, expect, type Page } from '@playwright/test';

/**
 * Slice: wikilinks (ADR-0004).
 *
 * `[[wikilink]]` is an OPTIONAL, NAME-based secondary link format alongside the
 * primary path-based markdown links. This drives the feature end-to-end against
 * the fake backend (a faithful port of the Rust name-resolution + backlink +
 * rename-rewrite math) and asserts the user-visible behavior:
 *
 *  - a resolved `[[name]]` rendered in live preview is clickable and OPENS the
 *    target Concept;
 *  - a `[[does-not-exist]]` renders with the broken-wikilink class
 *    (`.cm-atomic-wiki-link-missing`), matching the broken-markdown-link look;
 *  - an alias `[[name|Display Text]]` SHOWS "Display Text" and navigates to
 *    `name`; a broken aliased link gets the broken styling (overlay);
 *  - a Concept containing `[[target]]` appears in `target`'s Backlinks;
 *  - renaming a Concept's basename rewrites inbound `[[oldbase]]` → `[[newbase]]`;
 *  - `[[name#heading]]` navigates and scrolls to that heading.
 *
 * Fixtures are seeded at RUNTIME via the fake watcher hook (NOT by editing the
 * shared fixture module), so the Explorer tree other specs screenshot is left
 * untouched — same approach as link-auto-rewrite.spec.ts.
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
  await page.evaluate(
    ([p, b]) => {
      (window as unknown as FakeWindow).__sunstoneFake.simulateExternalChange(
        'created',
        p,
        b,
      );
    },
    [path, body] as const,
  );
}

/**
 * atomic-editor renders a resolved wikilink with `data-wiki-link-target` set to
 * the (trimmed) TARGET NAME only — the alias is NOT part of the attribute, so a
 * bare `[[wiki-target]]` and an aliased `[[wiki-target|Label]]` both carry
 * `data-wiki-link-target="wiki-target"`. They differ by their VISIBLE text (the
 * bare one shows the name, the aliased one shows the label), so we disambiguate
 * by text. The upstream click handler fires `onOpen` on a plain left click
 * anywhere in the element (unlike markdown links, which route through a trailing
 * icon hit-zone).
 */
async function clickWikiLink(page: Page, target: string, text: string): Promise<void> {
  const link = page
    .getByTestId('editor')
    .locator(`[data-wiki-link-target="${target}"]`, { hasText: text })
    .first();
  await expect(link).toBeVisible();
  await link.click();
}

/** Expand the right Sidebar (idempotent) so Backlinks is interactable. */
async function expandRightSidebar(page: Page): Promise<void> {
  const toggle = page.getByTestId('right-sidebar-edge');
  if ((await toggle.getAttribute('aria-pressed')) === 'false') await toggle.click();
}

/** Open the context menu for a tree node by right-clicking its row. */
async function openRowMenu(page: Page, path: string): Promise<void> {
  const tree = page.getByTestId('tree');
  await tree.locator(`[data-row-path="${path}"]`).click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
}

test('wikilink resolves + navigates, and broken/aliased links render correctly', async ({
  page,
}) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  // Seed a target Concept and a source whose body uses several wikilink forms.
  // `wiki-target.md` has a heading we later jump to via `[[...#heading]]`.
  await createConcept(
    page,
    'wiki-target.md',
    `${fm('Wiki Target')}# Wiki Target\n\nThe target body.\n\n## Deep Section\n\nDeep section body marmalade-anchor.\n`,
  );
  await createConcept(
    page,
    'wiki-source.md',
    `${fm('Wiki Source')}# Wiki Source\n\n` +
      // bare, resolves by basename (case-insensitive)
      `Bare link to [[wiki-target]] here.\n\n` +
      // aliased: shows "Open The Target", navigates to wiki-target
      `Aliased link [[wiki-target|Open The Target]] here.\n\n` +
      // broken bare
      `A broken link [[does-not-exist]] here.\n\n` +
      // broken aliased (overlay marks the label)
      `A broken aliased [[also-missing|Phantom Label]] here.\n`,
  );

  await expect(tree.locator('[data-path="wiki-source.md"]')).toBeVisible();
  await tree.locator('[data-path="wiki-source.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('Wiki Source');

  // (2) BROKEN bare wikilink: rendered with the missing class.
  const brokenBare = editor.locator('[data-wiki-link-target="does-not-exist"]');
  await expect(brokenBare).toHaveClass(/cm-atomic-wiki-link-missing/);

  // (3) ALIAS: the rendered label shows the display text (not the target name).
  // The alias is dropped from `data-wiki-link-target` (resolves by name), so the
  // aliased link carries the same target attr as the bare one but shows "Open
  // The Target" as its visible label.
  const alias = editor.locator('[data-wiki-link-target="wiki-target"]', {
    hasText: 'Open The Target',
  });
  await expect(alias).toBeVisible();
  await expect(alias).toHaveText('Open The Target');

  // (3b) BROKEN ALIASED link: the overlay marks the label as missing.
  await expect(
    editor.locator('.cm-atomic-wiki-link-missing', { hasText: 'Phantom Label' }),
  ).toBeVisible();

  // (1) RESOLVE + NAVIGATE: clicking the bare resolved link opens the target.
  await clickWikiLink(page, 'wiki-target', 'wiki-target');
  await expect(editor).toContainText('The target body.');
  await expect(tree.locator('[data-path="wiki-target.md"]')).toHaveClass(/selected/);

  // It pushed nav history: Back returns to the source.
  const back = page.getByTestId('nav-back');
  await expect(back).toBeEnabled();
  await back.click();
  await expect(editor).toContainText('Wiki Source');

  // (3) ALIAS navigates to the same target (wiki-target), despite its label.
  await clickWikiLink(page, 'wiki-target', 'Open The Target');
  await expect(editor).toContainText('The target body.');
  await expect(tree.locator('[data-path="wiki-target.md"]')).toHaveClass(/selected/);

  await page.screenshot({ path: 'tests/screenshots/wikilinks.png', fullPage: true });
});

test('wikilinks feed Backlinks', async ({ page }) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  await createConcept(page, 'bl-target.md', `${fm('BL Target')}# BL Target\n\nBody.\n`);
  await createConcept(
    page,
    'bl-source.md',
    `${fm('BL Source')}# BL Source\n\nLinks via [[bl-target]] to the target.\n`,
  );

  await expect(tree.locator('[data-path="bl-target.md"]')).toBeVisible();
  await tree.locator('[data-path="bl-target.md"]').click();

  await expandRightSidebar(page);
  const backlinks = page.getByTestId('backlinks');
  // The wikilink in bl-source.md resolves to bl-target.md → backlink edge.
  await expect(
    backlinks.locator('[data-testid="backlink"][data-path="bl-source.md"]'),
  ).toBeVisible();
});

test('rename rewrites inbound bare wikilinks to the new basename', async ({ page }) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  await createConcept(page, 'rn-target.md', `${fm('RN Target')}# RN Target\n\nBody.\n`);
  await createConcept(
    page,
    'rn-source.md',
    `${fm('RN Source')}# RN Source\n\nSee [[rn-target]] and [[rn-target|My Label]].\n`,
  );
  await expect(tree.locator('[data-path="rn-target.md"]')).toBeVisible();

  // Rename rn-target.md → rn-renamed.md (basename change).
  await openRowMenu(page, 'rn-target.md');
  await page.getByTestId('context-menu').locator('[data-action="rename"]').click();
  await page.getByTestId('dialog-input').fill('rn-renamed.md');
  await page.getByTestId('dialog-confirm').click();

  await expect(tree.locator('[data-path="rn-renamed.md"]')).toBeVisible();
  await expect(tree.locator('[data-path="rn-target.md"]')).toHaveCount(0);

  // The inbound bare wikilink was rewritten to the new basename; the alias is
  // preserved verbatim on the aliased form.
  const files = await page.evaluate(
    () => (window as unknown as FakeWindow).__sunstoneFake.files,
  );
  expect(files['rn-source.md']).toContain('[[rn-renamed]]');
  expect(files['rn-source.md']).toContain('[[rn-renamed|My Label]]');
  expect(files['rn-source.md']).not.toContain('[[rn-target');
});

test('wikilink with #heading navigates and scrolls to the heading', async ({ page }) => {
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();

  await createConcept(
    page,
    'hd-target.md',
    `${fm('HD Target')}# HD Target\n\nIntro.\n\n## Deep Section\n\nDeep body line.\n`,
  );
  await createConcept(
    page,
    'hd-source.md',
    `${fm('HD Source')}# HD Source\n\nJump to [[hd-target#Deep Section]] now.\n`,
  );
  await expect(tree.locator('[data-path="hd-source.md"]')).toBeVisible();
  await tree.locator('[data-path="hd-source.md"]').click();

  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('HD Source');

  // Clicking the anchored wikilink navigates to the target Concept...
  // The widget's visible label is the NAME part only (anchor stripped) → "hd-target".
  await clickWikiLink(page, 'hd-target#Deep Section', 'hd-target');
  await expect(editor).toContainText('Deep body line.');
  await expect(tree.locator('[data-path="hd-target.md"]')).toHaveClass(/selected/);

  // ...and scrolls the heading into the viewport (best-effort scroll, ADR-0004).
  const heading = editor.locator('.cm-line', { hasText: 'Deep Section' }).first();
  await expect(heading).toBeInViewport();
});
