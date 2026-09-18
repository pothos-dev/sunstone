import { test, expect } from './fixtures';

/**
 * Embeds resolving against a REAL backend (ticket ei-1).
 *
 * The desktop Playwright suite drives the in-memory fake, whose Attachments are
 * seeded `data:` URLs — so it can never prove that the name-resolved Embed form
 * works against a real Bundle on disk. This spec does, over the web e2e stack:
 * the real `sunstone-server` indexing `tests/fixtures/web-bundle` (which carries
 * `assets/wide.png`, a 64x16 PNG) behind the SSR web build's `/api` proxy.
 *
 * Two links in one chain are asserted here:
 *   1. `GET /api/attachment-paths` — the seam method `Backend.listAttachmentPaths`
 *      is implemented against (`Index::attachment_paths` over the live index),
 *      and the reason the frontend's Embed corpus is no longer empty outside the
 *      fake;
 *   2. `![[wide.png]]` in `embeds.md` rendering to an `<img>` that actually
 *      DECODES — name-resolved bundle-wide (the Concept never names `assets/`)
 *      under the ADR-0004 rules.
 */

/** The one Attachment the fixture Bundle carries, and its natural size. */
const ATTACHMENT = 'assets/wide.png';
const NATURAL_WIDTH = 64;
const NATURAL_HEIGHT = 16;

test('the Attachment index is served over its own route, separate from the Concept list', async ({
  page,
}) => {
  const attachments = await (await page.request.get('/api/attachment-paths')).json();
  expect(attachments).toEqual([ATTACHMENT]);

  // Two corpora, never one filtered list: the Attachment is absent from the
  // `.md`-only Concept set that feeds the tree, Quick nav and wikilinks.
  const concepts: string[] = await (await page.request.get('/api/concept-paths')).json();
  expect(concepts).toContain('embeds.md');
  expect(concepts).not.toContain(ATTACHMENT);
});

test('`![[name.png]]` resolves by name against a real Bundle and the image loads', async ({
  page,
}) => {
  await page.goto('/embeds');
  const rendered = page.getByTestId('rendered');
  await expect(rendered.locator('h1')).toContainText('Embeds Concept');

  // Both resolvable Embeds map to the server's asset URL; neither keeps the
  // author's raw relative/bundle path (which the browser could not fetch).
  const images = rendered.locator('img.embed-image');
  await expect(images).toHaveCount(2);

  // The NAME-resolved one: `![[wide.png]]` found `assets/wide.png` bundle-wide.
  const byName = images.first();
  await expect(byName).toHaveAttribute('src', '/api/asset?path=assets%2Fwide.png');
  // The accessible name is the filename with extension (ADR-0010), so this is
  // also proof the target that was resolved is the Attachment, not the alt text.
  await expect(byName).toHaveAttribute('alt', 'wide.png');

  // It genuinely DECODED — the bytes came back over `/api/asset`, not just a
  // plausible-looking `src`. (`loading="lazy"`, so bring it into view first.)
  await byName.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      byName.evaluate((el: HTMLImageElement) => ({
        w: el.naturalWidth,
        h: el.naturalHeight,
      })),
    )
    .toEqual({ w: NATURAL_WIDTH, h: NATURAL_HEIGHT });

  // An unresolvable Embed degrades to the placeholder and the Concept still
  // renders around it.
  const broken = rendered.locator('span.embed-broken[data-broken="true"]');
  await expect(broken).toHaveCount(1);
  await expect(broken).toHaveAttribute('data-embed-target', 'missing.png');
  await expect(rendered.locator('p').last()).toContainText('the page clearly stays intact');
});
