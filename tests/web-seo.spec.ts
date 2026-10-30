import { test, expect } from './fixtures';

// The absolute URLs use the request origin. Without `ORIGIN` set, adapter-node
// takes the protocol to be https, as it is behind a TLS-terminating proxy.
const ORIGIN = 'https://localhost:5199';

/**
 * What Sunstone Web tells crawlers (`src/lib/web/seo.ts`, served by the hook in
 * `src/hooks.server.ts`): the page `<head>` tags, a real 404 for a URL that
 * names no Concept, and the root `robots.txt`, `sitemap.xml` and `llms.txt`.
 */

test('a page carries its description, canonical URL and Open Graph tags', async ({ request }) => {
  const res = await request.get('/guide/topic');
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('<title>Topic · Web Bundle Home</title>');
  expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/guide/topic"`);
  expect(html).toContain('<meta property="og:site_name" content="Web Bundle Home"');
  expect(html).toContain('<meta property="og:title" content="Topic · Web Bundle Home"');
  expect(html).toContain('<meta name="description" content="Lifecycle markers on a deprecated page."');
  expect(html).toContain('<meta property="og:description" content="Lifecycle markers on a deprecated page."');
});

test('a URL that names no Concept is a 404 that still renders the reader', async ({ request }) => {
  const res = await request.get('/no/such/page');
  expect(res.status()).toBe(404);
  expect(res.headers()['x-sunstone-not-found']).toBeUndefined();
  expect(await res.text()).toContain('Concept not found: /no/such/page');
});

test('robots.txt allows crawling and names the sitemap', async ({ request }) => {
  const res = await request.get('/robots.txt');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('text/plain; charset=utf-8');
  expect(await res.text()).toBe(`User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
});

test('sitemap.xml lists every Concept at its pretty URL', async ({ request }) => {
  const res = await request.get('/sitemap.xml');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/xml; charset=utf-8');
  const xml = await res.text();
  expect(xml).toContain(`<loc>${ORIGIN}/</loc>`);
  expect(xml).toContain(`<loc>${ORIGIN}/good</loc>`);
  expect(xml).toContain(`<loc>${ORIGIN}/guide</loc>`);
  expect(xml).toContain(`<loc>${ORIGIN}/guide/topic</loc>`);
  expect(xml).not.toContain('.md</loc>');
});

test('llms.txt names the site and links every page', async ({ request }) => {
  const res = await request.get('/llms.txt');
  expect(res.status()).toBe(200);
  const txt = await res.text();
  expect(txt.startsWith('# Web Bundle Home\n')).toBe(true);
  expect(txt).toContain(`- [Good Concept](${ORIGIN}/good)`);
  expect(txt).toContain(`- [Topic](${ORIGIN}/guide/topic): Lifecycle markers on a deprecated page.`);
});
