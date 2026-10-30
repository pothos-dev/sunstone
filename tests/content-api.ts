import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';

/**
 * The content API (`crates/sunstone-server/src/routes_content.rs`) over the
 * `tests/fixtures/web-bundle` fixture, against whichever stack the calling
 * spec's runner boots: Sunstone Web (`web-content-api.spec.ts`, through the
 * SvelteKit hook) or `sunstone serve` (`serve-content-api.spec.ts`, through
 * the app-shell fallback). Both must answer the same.
 */
export function contentApiSpecs(): void {
  const json = { accept: 'application/json' };

  const get = (request: APIRequestContext, url: string, accept: string) =>
    request.get(url, { headers: { accept }, maxRedirects: 0 });

  test('a page URL answers Markdown when asked', async ({ request }) => {
    for (const url of ['/guide/topic', '/guide/topic.md']) {
      const res = await get(request, url, 'text/markdown');
      expect(res.status(), url).toBe(200);
      expect(res.headers()['content-type']).toBe('text/markdown; charset=utf-8');
      expect(res.headers()['vary']).toContain('Accept');
      const text = await res.text();
      expect(text.startsWith('---\ntype: concept\ntitle: Topic\n')).toBe(true);
      expect(text).toContain('A guide topic Concept');
    }
  });

  test('a page URL answers JSON when asked', async ({ request }) => {
    const res = await request.get('/guide', { headers: json });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/json');
    const doc = await res.json();
    expect(doc.path).toBe('guide/index.md');
    expect(doc.frontmatter).toEqual({ type: 'index', title: 'Guide' });
    expect(doc.body).toContain('The guide section index page');
    expect(Array.isArray(doc.links)).toBe(true);
    expect(Array.isArray(doc.backlinks)).toBe(true);

    const home = await (await request.get('/', { headers: json })).json();
    expect(home.path).toBe('index.md');
    expect(home.links).toContain('good.md');
  });

  test('a browser still gets the page', async ({ request }) => {
    const res = await get(request, '/guide/topic', 'text/html,application/xhtml+xml,*/*;q=0.8');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
    expect(res.headers()['vary']).toContain('Accept');
  });

  test('?list lists a folder, filterable', async ({ request }) => {
    const all = await (await request.get('/?list', { headers: json })).json();
    const paths = all.map((c: { path: string }) => c.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain('index.md');
    expect(paths).toContain('guide/topic.md');

    const guide = await (await request.get('/guide?list', { headers: json })).json();
    expect(guide).toEqual([
      { path: 'guide/index.md', title: 'Guide', description: null, type: 'index', tags: [], timestamp: null },
      { path: 'guide/topic.md', title: 'Topic', description: 'Lifecycle markers on a deprecated page.', type: 'concept', tags: [], timestamp: null },
    ]);

    const indexes = await (await request.get('/?list&type=index', { headers: json })).json();
    expect(indexes.map((c: { path: string }) => c.path)).toEqual(['guide/index.md', 'index.md']);
    const demo = await (await request.get('/?list&tag=demo', { headers: json })).json();
    expect(demo.map((c: { path: string }) => c.path)).toEqual(['index.md']);
  });

  test('?q searches a folder', async ({ request }) => {
    const hits = await (await request.get('/guide?q=GUIDE%20TOPIC', { headers: json })).json();
    expect(hits).toEqual([
      {
        path: 'guide/topic.md',
        title: 'Topic',
        line: 11,
        snippet: 'A guide topic Concept (an ordinary tree row inside the guide folder).',
      },
    ]);
  });

  test('errors are JSON', async ({ request }) => {
    const missing = await request.get('/guide/nope', { headers: json });
    expect(missing.status()).toBe(404);
    expect((await missing.json()).error).toContain('/guide/nope');

    const list = await get(request, '/?list', 'text/markdown');
    expect(list.status()).toBe(406);
  });
}
