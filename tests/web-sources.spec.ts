import { test, expect } from './fixtures';

/**
 * ov-17 in the web viewer: footnotes citing a `sources` entry show the source
 * card the moment the pointer is over them (the same card as the editor,
 * bound over the server-rendered body through `data-source`), and the Sources
 * section after the body lists the entries. A click on a source footnote
 * opens the cited Concept within the viewer.
 */
test('source footnotes show their card and open the source', async ({ page }) => {
  await page.goto('/cited');
  const rendered = page.getByTestId('rendered');
  await expect(rendered.locator('h1')).toContainText('Cited Concept');
  // Gate on hydration: the Tags Section renders from an onMount fetch in the
  // same cycle that binds the source cards (see web-viewer.spec.ts).
  await expect(page.getByTestId('tag-browser')).toBeVisible();

  const refs = rendered.locator('sup.footnote-ref.source');
  await expect(refs).toHaveCount(2);
  await expect(refs.nth(0)).not.toHaveAttribute('title');

  const card = page.getByTestId('source-card');
  await refs.nth(0).hover();
  await expect(card).toHaveCount(1);
  await expect(card.locator('.source-card-title')).toHaveText('The good Concept');
  await expect(card.locator('.source-card-resource')).toHaveText('/good.md');
  await expect(card.locator('.source-card-meta')).toContainText('Authorpersondan');

  await refs.nth(1).hover();
  await expect(card.locator('.source-card-title')).toHaveText('all queries in project X');
  await expect(card.locator('.source-card-hint')).toHaveCount(0);

  // The Sources section, and a card over its titles too.
  const section = rendered.locator('section.sources');
  await expect(section.locator('li')).toHaveCount(2);
  await section.locator('.source-title', { hasText: 'The good Concept' }).hover();
  await expect(card.locator('.source-card-num')).toHaveText('1');
  await page.mouse.move(2, 2);
  await expect(card).toHaveCount(0);

  await refs.nth(0).locator('a').click();
  await expect(page).toHaveURL(/\/good$/);
  await expect(rendered.locator('h1')).toContainText('Good Concept');
  await expect(card).toHaveCount(0);
});

test('Sources entries show their signals and jump back to the citing claim', async ({ page }) => {
  await page.goto('/cited');
  const rendered = page.getByTestId('rendered');
  await expect(rendered.locator('h1')).toContainText('Cited Concept');
  const section = rendered.locator('section.sources');
  const good = section.locator('li').nth(0);
  // `author` as an actor, the same markup as the editor's.
  await expect(good.locator('.source-signals .actor-human .actor-id')).toHaveText('dan');
  // The jump back targets the citing superscript.
  const back = good.locator('a.source-backref');
  await expect(back).toHaveAttribute('href', '#fnref-good-1');
  await expect(rendered.locator('sup#fnref-good-1')).toHaveCount(1);
  await back.click();
  await expect(page).toHaveURL(/#fnref-good-1$/);
});
