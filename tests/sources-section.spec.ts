import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * ov-17: footnotes that cite `sources`, and the Sources section.
 *
 * A `[^id]` matching a `sources[].id` shows the entry's details on hover and a
 * click opens the resource directly: an in-Bundle path navigates the Tile, a
 * URL goes to `backend.openExternal` (the fake's `window.open`, spied on here).
 * A scope descriptor is not clickable. The `sources` list renders as a Sources
 * section after the body, cited entries by number, then uncited ones. Driven
 * against the fake backend.
 */

type FakeWindow = Window & {
  __sunstoneFake: {
    simulateExternalChange: (kind: string, path: string, content?: string) => void;
  };
  __opened: string[];
};

const BODY =
  '---\ntype: module\ntitle: Messwerte\nsources:\n' +
  '  - id: demo\n    resource: /concepts/links-demo.md\n    title: Links demo\n' +
  '  - id: web\n    resource: https://example.com/spec\n    title: The spec\n    author: human:dan\n' +
  '  - id: scope\n    resource: all queries in project X\n' +
  '  - id: unused\n    resource: https://example.com/unused\n' +
  '---\n\n# Messwerte\n\n' +
  'Die Kachel ist aktiv.[^web][^demo] Leerzustand.[^scope]\n';

async function openConcept(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as FakeWindow;
    w.__opened = [];
    const orig = window.open.bind(window);
    window.open = ((url?: string | URL, ...rest: unknown[]) => {
      w.__opened.push(String(url));
      return orig(url as string, ...(rest as [string?, string?]));
    }) as typeof window.open;
  });
  await page.goto('/');
  const tree = page.getByTestId('tree');
  await expect(tree).toBeVisible();
  await page.waitForFunction(() => '__sunstoneFake' in window);
  await page.evaluate((b) => {
    (window as unknown as FakeWindow).__sunstoneFake.simulateExternalChange('created', 'm03.md', b);
  }, BODY);
  await tree.locator('[data-path="m03.md"]').click();
  const editor = page.getByTestId('editor');
  await expect(editor).toContainText('Die Kachel ist aktiv.');
  return editor;
}

test('a source footnote shows the entry card on hover; a descriptor is not a link', async ({
  page,
}) => {
  const editor = await openConcept(page);
  const refs = editor.locator('.cm-footnote-ref');
  await expect(refs).toHaveCount(3);
  await expect(refs.nth(0)).toHaveText('1');
  await expect(refs.nth(0)).toHaveAttribute('role', 'link');
  await expect(refs.nth(0)).not.toHaveAttribute('title');
  await expect(refs.nth(1)).toHaveText(',2');
  await expect(refs.nth(2)).toHaveText('3');
  await expect(refs.nth(2)).not.toHaveAttribute('role', 'link');
  await expect(editor.locator('.cm-footnote-broken')).toHaveCount(0);

  const card = page.getByTestId('source-card');
  await refs.nth(0).hover();
  await expect(card).toHaveCount(1);
  await expect(card.locator('.source-card-title')).toHaveText('The spec');
  await expect(card.locator('.source-card-resource')).toHaveText('https://example.com/spec');
  // `author` is an actor (§7): a person chip, then the id without its prefix.
  const author = card.locator('.source-card-meta .actor-human');
  await expect(author.locator('.actor-kind')).toHaveText('person');
  await expect(author.locator('.actor-id')).toHaveText('dan');
  await expect(author).toHaveAttribute('title', 'Person: dan');
  await expect(card.locator('.source-card-num')).toHaveText('1');

  await refs.nth(2).hover();
  await expect(card).toHaveCount(1);
  await expect(card.locator('.source-card-title')).toHaveText('all queries in project X');
  await expect(card.locator('.source-card-hint')).toHaveCount(0);

  await page.mouse.move(5, 5);
  await expect(card).toHaveCount(0);
});

test('clicking a source footnote opens a URL externally', async ({ page }) => {
  const editor = await openConcept(page);
  await editor.locator('.cm-footnote-ref[data-footnote="web"]').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as FakeWindow).__opened))
    .toContain('https://example.com/spec');
  await expect(page.locator('[data-path="m03.md"]')).toHaveClass(/selected/);
});

test('clicking a source footnote opens an in-Bundle Concept', async ({ page }) => {
  const editor = await openConcept(page);
  await editor.locator('.cm-footnote-ref[data-footnote="demo"]').click();
  await expect(page.locator('[data-path="concepts/links-demo.md"]')).toHaveClass(/selected/);
  await expect(editor).toContainText('An external link is never treated as broken');
});

test('the Sources section lists cited entries by number, then uncited ones', async ({ page }) => {
  const editor = await openConcept(page);
  const section = editor.getByTestId('sources-section');
  await section.scrollIntoViewIfNeeded();
  await expect(section).toBeVisible();
  const rows = section.locator('li');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('1The spechttps://example.com/spec');
  await expect(rows.nth(1)).toContainText('2Links demo/concepts/links-demo.md');
  await expect(rows.nth(2)).toHaveText('3all queries in project X');
  await expect(rows.nth(3).locator('.cm-source-num')).toHaveText('');
  // The section is not part of the document.
  await expect(editor.locator('.cm-line', { hasText: 'Sources' })).toHaveCount(0);

  await rows.nth(1).locator('.cm-source-title').click();
  await expect(page.locator('[data-path="concepts/links-demo.md"]')).toHaveClass(/selected/);
});
