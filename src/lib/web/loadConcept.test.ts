import { describe, expect, mock, test } from 'bun:test';

// `loadConcept` → `$lib/wasm` reads SvelteKit's `$app/environment`, which only
// exists inside a Kit build. Pin the SSR side (`browser: false`), where the
// inline URL resolver runs and wasm is never touched.
mock.module('$app/environment', () => ({ browser: false }));

const { loadConcept } = await import('./loadConcept');

const TREE = {
  name: 'root',
  path: '',
  isDir: true,
  children: [{ name: 'good.md', path: 'good.md', isDir: false }],
};

type Route = { status: number; body: unknown };

/** A `fetch` answering from a path → response table (404 otherwise). */
function fakeFetch(routes: Record<string, Route>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const r = routes[url];
    if (!r) return new Response('nope', { status: 404 });
    // Successes are JSON; an error body is the upstream's plain text.
    const text = r.status >= 400 ? String(r.body) : JSON.stringify(r.body);
    return new Response(text, { status: r.status });
  }) as typeof fetch;
}

const OK_ROUTES: Record<string, Route> = {
  '/_api/bundle-root': { status: 200, body: '/bundle' },
  '/_api/tree': { status: 200, body: TREE },
  '/auth/session': { status: 200, body: null },
  '/_api/render?path=good.md': { status: 200, body: { html: '<p>hi</p>', frontmatter: [], outline: [] } },
};

describe('loadConcept', () => {
  test('loads the root, tree and the rendered Concept', async () => {
    const data = await loadConcept(fakeFetch(OK_ROUTES), 'good');
    expect(data.bundleRoot).toBe('/bundle');
    expect(data.selected).toBe('good.md');
    expect(data.rendered?.html).toBe('<p>hi</p>');
    expect(data.renderError).toBeNull();
    expect(data.user).toBeNull();
  });

  test('a failing /_api/tree surfaces the upstream status, not a JSON parse error', async () => {
    const f = fakeFetch({ ...OK_ROUTES, '/_api/tree': { status: 503, body: 'upstream down' } });
    const err = await loadConcept(f, 'good').then(
      () => null,
      (e: unknown) => e as { status?: number; body?: { message?: string } },
    );
    expect(err?.status).toBe(502);
    expect(err?.body?.message).toBe('Cannot load /_api/tree: 503: upstream down');
  });

  test('a failing /_api/bundle-root surfaces the upstream status', async () => {
    const f = fakeFetch({ ...OK_ROUTES, '/_api/bundle-root': { status: 500, body: '' } });
    const err = await loadConcept(f, '').then(
      () => null,
      (e: unknown) => e as { status?: number; body?: { message?: string } },
    );
    expect(err?.status).toBe(502);
    expect(err?.body?.message).toBe('Cannot load /_api/bundle-root: 500: no response body');
  });
});
