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
  '    usage_count: 42\n    last_modified: 2026-05-30T00:00:00Z\n' +
  '  - id: scope\n    resource: all queries in project X\n' +
  '  - id: unused\n    resource: https://example.com/unused\n' +
  'usage_window: { from: 2026-06-01T00:00:00Z, to: 2026-06-30T00:00:00Z }\n' +
  '---\n\n# Messwerte\n\n' +
  'Die Kachel ist aktiv.[^web][^demo] Leerzustand.[^scope]\n\n' +
  'Zweiter Absatz.[^web]\n\n' +
  '[^web]: Handgeschriebene Notiz\n';

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
  await expect(refs).toHaveCount(4);
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
  // The id the body cites it by, beside the number it shows as.
  await expect(card.locator('.source-card-id')).toHaveText('web');

  await refs.nth(2).hover();
  await expect(card).toHaveCount(1);
  await expect(card.locator('.source-card-title')).toHaveText('all queries in project X');
  await expect(card.locator('.source-card-hint')).toHaveCount(0);

  await page.mouse.move(5, 5);
  await expect(card).toHaveCount(0);
});

test('clicking a source footnote opens a URL externally', async ({ page }) => {
  const editor = await openConcept(page);
  await editor.locator('.cm-footnote-ref[data-footnote="web"]').first().click();
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
  const cell = (i: number, cls: string) => rows.nth(i).locator(cls);
  await expect(cell(0, '.cm-source-num')).toHaveText('1');
  await expect(cell(0, '.cm-source-title')).toHaveText('The spec');
  await expect(cell(0, '.cm-source-resource')).toHaveText('https://example.com/spec');
  await expect(cell(1, '.cm-source-num')).toHaveText('2');
  await expect(cell(1, '.cm-source-title')).toHaveText('Links demo');
  await expect(cell(1, '.cm-source-resource')).toHaveText('/concepts/links-demo.md');
  await expect(cell(2, '.cm-source-num')).toHaveText('3');
  await expect(cell(2, '.cm-source-title')).toHaveText('all queries in project X');
  await expect(cell(3, '.cm-source-num')).toHaveText('');
  // The section is not part of the document.
  await expect(editor.locator('.cm-line', { hasText: 'Sources' })).toHaveCount(0);

  await rows.nth(1).locator('.cm-source-title').click();
  await expect(page.locator('[data-path="concepts/links-demo.md"]')).toHaveClass(/selected/);
});

test('an entry shows its signals as written and a hidden body definition', async ({ page }) => {
  const editor = await openConcept(page);
  const section = editor.getByTestId('sources-section');
  await section.scrollIntoViewIfNeeded();
  const web = section.locator('li').nth(0);
  // Author as an actor, the values as written, the count over its window.
  await expect(web.locator('.cm-source-signals .actor-human .actor-id')).toHaveText('dan');
  await expect(web.locator('.cm-source-signals')).toContainText('Last modified 2026-05-30T00:00:00Z');
  await expect(web.locator('.cm-source-signals')).toContainText(
    'Usage count 42 (2026-06-01T00:00:00Z – 2026-06-30T00:00:00Z)',
  );
  // The body definition's text moves onto the entry; its line is not shown.
  await expect(web.locator('.cm-source-note')).toHaveText('Handgeschriebene Notiz');
  await expect(editor.locator('.cm-line', { hasText: 'Handgeschriebene' })).toHaveCount(0);
  await expect(editor.locator('.cm-footnote-def')).toHaveCount(0);
  // Never written to the file: the text is still where it was.
  const file = await page.evaluate(
    () => (window as unknown as { __sunstoneFake: { files: Record<string, string> } }).__sunstoneFake.files['m03.md'],
  );
  expect(file).toContain('[^web]: Handgeschriebene Notiz');
  expect(file).not.toContain('Sources');
});

test('an entry jumps back to each claim citing it', async ({ page }) => {
  const editor = await openConcept(page);
  const section = editor.getByTestId('sources-section');
  await section.scrollIntoViewIfNeeded();
  const back = section.locator('li').nth(0).locator('.cm-source-backref');
  await expect(back).toHaveText(['a', 'b']);
  await back.nth(1).click();
  await expect(editor.locator('.cm-citation-target')).toContainText('Zweiter Absatz.');
  await back.nth(0).click();
  await expect(editor.locator('.cm-citation-target')).toContainText('Die Kachel ist aktiv.');
  // A single citing place is a lone arrow.
  await expect(section.locator('li').nth(1).locator('.cm-source-backref')).toHaveText(['↑']);
  // An uncited entry has none.
  await expect(section.locator('li').nth(3).locator('.cm-source-backref')).toHaveCount(0);
});

test('Edit opens the Frontmatter on that entry, unfolded, caret on it', async ({ page }) => {
  const editor = await openConcept(page);
  const section = editor.getByTestId('sources-section');
  await section.scrollIntoViewIfNeeded();
  const scope = section.locator('li').nth(2);
  await scope.hover();
  await scope.getByTestId('source-edit').click();

  const fm = page.getByTestId('frontmatter-editor');
  await expect(fm).toBeVisible();
  // The entry is visible; the other multi-line entries are folded away.
  await expect(fm.locator('.cm-line', { hasText: 'resource: all queries in project X' })).toBeVisible();
  await expect(fm.locator('.cm-line', { hasText: 'title: The spec' })).toHaveCount(0);
  // The caret is in the YAML, on the entry.
  await expect(fm.locator('.cm-editor')).toHaveClass(/cm-focused/);
  const caretLine = await page.evaluate(() => {
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    const el = node instanceof Element ? node : node?.parentElement;
    return el?.closest('.cm-line')?.textContent ?? null;
  });
  expect(caretLine).toContain('id: scope');
  // Editing is YAML only, so Edit switched to editing mode.
  await expect(fm.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
});
