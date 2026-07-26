import { test, expect, afterEach } from 'bun:test';
import { parseFileChange, parseSyncNotice, httpWriteError, httpBackend, CLIENT_ID } from './http';

// Pure parsing of an SSE `data:` payload into a `FileChange` (the `EventSource`
// bridge in `onFileChanged` only forwards a non-null result to the callback).

test('parses a well-formed change payload for each kind', () => {
  for (const kind of ['created', 'modified', 'removed'] as const) {
    expect(parseFileChange(JSON.stringify({ kind, paths: ['a/b.md'] }))).toEqual({
      kind,
      paths: ['a/b.md'],
    });
  }
});

test('parses multiple paths', () => {
  expect(parseFileChange('{"kind":"modified","paths":["x.md","y/z.md"]}')).toEqual({
    kind: 'modified',
    paths: ['x.md', 'y/z.md'],
  });
});

test('rejects malformed JSON', () => {
  expect(parseFileChange('not json')).toBeNull();
  expect(parseFileChange('')).toBeNull();
});

test('rejects an unknown kind or wrong-typed fields', () => {
  expect(parseFileChange('{"kind":"renamed","paths":["a.md"]}')).toBeNull();
  expect(parseFileChange('{"kind":"created"}')).toBeNull();
  expect(parseFileChange('{"kind":"created","paths":"a.md"}')).toBeNull();
  expect(parseFileChange('{"kind":"created","paths":[1,2]}')).toBeNull();
});

// --- origin stamping (ticket 08) -------------------------------------------

test('carries a well-formed web-write origin through', () => {
  const change = parseFileChange(
    '{"kind":"modified","paths":["a.md"],"origin":{"clientId":"tab-1","author":{"name":"Ada"}}}',
  );
  expect(change).toEqual({
    kind: 'modified',
    paths: ['a.md'],
    origin: { clientId: 'tab-1', author: { name: 'Ada' } },
  });
});

test('drops a malformed origin but keeps the change', () => {
  // Missing author.name — the change is still valid, just un-attributed.
  const change = parseFileChange('{"kind":"modified","paths":["a.md"],"origin":{"clientId":"t"}}');
  expect(change).toEqual({ kind: 'modified', paths: ['a.md'] });
  expect(change?.origin).toBeUndefined();
});

// --- write error mapping (ticket 07 §8) ------------------------------------

test('httpWriteError maps each status to a message', () => {
  expect(httpWriteError(400, 'path escapes the bundle: ../x')).toBe(
    'Invalid path: path escapes the bundle: ../x',
  );
  expect(httpWriteError(401, '')).toContain('signed in');
  expect(httpWriteError(404, 'target folder does not exist')).toBe(
    'Not found: target folder does not exist',
  );
  expect(httpWriteError(409, 'already exists: a.md')).toBe('Conflict: already exists: a.md');
  expect(httpWriteError(500, '')).toBe('Save failed (500)');
});

// --- write request shaping (fetch mock) ------------------------------------

type Captured = { url: string; init: RequestInit };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub `fetch` to capture the request and return `response`. */
function stubFetch(response: Response): () => Captured {
  let captured: Captured | undefined;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    captured = { url, init };
    return Promise.resolve(response);
  }) as typeof fetch;
  return () => captured!;
}

test('writeConcept PUTs JSON with the client-id header and resolves on 204', async () => {
  const get = stubFetch(new Response(null, { status: 204 }));
  await expect(httpBackend.writeConcept('a.md', 'hello')).resolves.toBeUndefined();
  const { url, init } = get();
  expect(url).toBe('/api/concept');
  expect(init.method).toBe('PUT');
  expect(JSON.parse(init.body as string)).toEqual({ path: 'a.md', content: 'hello' });
  expect((init.headers as Record<string, string>)['x-sunstone-client']).toBe(CLIENT_ID);
});

test('createConcept and createFolder POST to their nouns', async () => {
  let get = stubFetch(new Response(null, { status: 204 }));
  await httpBackend.createConcept('n.md');
  expect(get().url).toBe('/api/concept');
  expect(get().init.method).toBe('POST');
  expect(JSON.parse(get().init.body as string)).toEqual({ path: 'n.md' });

  get = stubFetch(new Response(null, { status: 204 }));
  await httpBackend.createFolder('sub');
  expect(get().url).toBe('/api/folder');
  expect(JSON.parse(get().init.body as string)).toEqual({ path: 'sub' });
});

test('deletePath DELETEs with a query param, no body', async () => {
  const get = stubFetch(new Response(null, { status: 204 }));
  await httpBackend.deletePath('a/b.md');
  expect(get().url).toBe('/api/concept?path=a%2Fb.md');
  expect(get().init.method).toBe('DELETE');
  expect(get().init.body).toBeUndefined();
});

test('renamePath / movePath POST and parse the RewriteSummary', async () => {
  let get = stubFetch(
    new Response(JSON.stringify({ linksChanged: 3, filesChanged: 2 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  await expect(httpBackend.renamePath('a.md', 'b.md')).resolves.toEqual({
    linksChanged: 3,
    filesChanged: 2,
  });
  expect(get().url).toBe('/api/rename');
  expect(JSON.parse(get().init.body as string)).toEqual({ from: 'a.md', to: 'b.md' });

  get = stubFetch(
    new Response(JSON.stringify({ linksChanged: 0, filesChanged: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  await httpBackend.movePath('a.md', 'sub');
  expect(get().url).toBe('/api/move');
  expect(JSON.parse(get().init.body as string)).toEqual({ from: 'a.md', toDir: 'sub' });
});

test('rewriteAnchors POSTs target + renames', async () => {
  const get = stubFetch(
    new Response(JSON.stringify({ linksChanged: 1, filesChanged: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  await httpBackend.rewriteAnchors('t.md', [{ from: 'intro', to: 'setup' }]);
  expect(get().url).toBe('/api/rewrite-anchors');
  expect(JSON.parse(get().init.body as string)).toEqual({
    target: 't.md',
    renames: [{ from: 'intro', to: 'setup' }],
  });
});

test('a non-2xx write rejects with the mapped message', async () => {
  stubFetch(new Response('already exists: a.md', { status: 409 }));
  await expect(httpBackend.createConcept('a.md')).rejects.toThrow('Conflict: already exists: a.md');
});

// --- index read shaping: types + keys --------------------------------------

test('allTypes GETs /api/types and returns the string array', async () => {
  const get = stubFetch(
    new Response(JSON.stringify(['concept', 'index']), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  await expect(httpBackend.allTypes()).resolves.toEqual(['concept', 'index']);
  expect(get().url).toBe('/api/types');
});

test('allKeys GETs /api/keys and returns the string array', async () => {
  const get = stubFetch(
    new Response(JSON.stringify(['description', 'tags', 'title', 'type']), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  await expect(httpBackend.allKeys()).resolves.toEqual(['description', 'tags', 'title', 'type']);
  expect(get().url).toBe('/api/keys');
});

// --- gated git read routes (git-sync spec §11) ------------------------------
// `/api/history` + `/api/file-at-rev` are session-gated in `hooks.server.ts`, so
// the seam has to distinguish "you cannot have history here" (an unavailable
// capability → `gitMissing`, which just disables the review-diff toggle) from a
// real error. Per the seam's contract, ONLY a path escape (400) rejects; every
// other failure — 401, 404 (a server predating these routes), 500, 503, a
// network throw — is an unavailable capability. A rejection instead would leave
// the review toggle stuck on "Checking git history…" forever.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('fileHistory GETs /api/history and passes the FileHistory through', async () => {
  const commits = [
    {
      hash: 'abc1234',
      subject: 'edit notes/foo.md via web',
      author: 'Ada',
      date: '2026-07-26T10:15:00+00:00',
      relativeDate: '3 minutes ago',
    },
  ];
  const get = stubFetch(jsonResponse({ status: 'ok', commits }));
  await expect(httpBackend.fileHistory('notes/foo.md')).resolves.toEqual({
    status: 'ok',
    commits,
  });
  expect(get().url).toBe('/api/history?path=notes%2Ffoo.md');
});

test('fileHistory passes a git-backed unavailable status through untouched', async () => {
  for (const status of ['notARepo', 'untracked', 'noHistory', 'gitMissing'] as const) {
    stubFetch(jsonResponse({ status }));
    await expect(httpBackend.fileHistory('notes/foo.md')).resolves.toEqual({ status });
  }
});

test('fileHistory maps every non-400 failure to gitMissing (fail-safe)', async () => {
  // 401 not signed in / 404 a server predating these routes / 500 / 503 no auth.
  for (const status of [401, 404, 500, 503]) {
    stubFetch(new Response('nope', { status }));
    await expect(httpBackend.fileHistory('notes/foo.md')).resolves.toEqual({
      status: 'gitMissing',
    });
  }
});

test('a network-level throw yields gitMissing, not a rejection', async () => {
  globalThis.fetch = (() =>
    Promise.reject(new Error('connection refused'))) as unknown as typeof fetch;
  await expect(httpBackend.fileHistory('notes/foo.md')).resolves.toEqual({
    status: 'gitMissing',
  });
  await expect(httpBackend.fileAtRev('notes/foo.md', 'HEAD')).resolves.toEqual({
    status: 'gitMissing',
  });
});

test('fileAtRev GETs /api/file-at-rev with path + rev and returns the content', async () => {
  const get = stubFetch(jsonResponse({ status: 'ok', content: '# hi' }));
  await expect(httpBackend.fileAtRev('notes/foo.md', 'HEAD~1')).resolves.toEqual({
    status: 'ok',
    content: '# hi',
  });
  expect(get().url).toBe('/api/file-at-rev?path=notes%2Ffoo.md&rev=HEAD~1');
});

test('fileAtRev maps every non-400 failure to gitMissing', async () => {
  for (const status of [401, 404, 500, 503]) {
    stubFetch(new Response('nope', { status }));
    await expect(httpBackend.fileAtRev('notes/foo.md', 'HEAD')).resolves.toEqual({
      status: 'gitMissing',
    });
  }
});

test('a gated git read STILL rejects on a path escape (400) — the one case', async () => {
  stubFetch(new Response('path escapes the bundle: ../x', { status: 400 }));
  await expect(httpBackend.fileHistory('../x')).rejects.toThrow('path escapes the bundle');

  stubFetch(new Response('path escapes the bundle: ../x', { status: 400 }));
  await expect(httpBackend.fileAtRev('../x', 'HEAD')).rejects.toThrow('path escapes the bundle');
});

// --- sync notices: the named `sync` SSE event (git-sync spec §10.2-10.3) -----

test('parses both sync notice kinds', () => {
  expect(
    parseSyncNotice(
      '{"kind":"forked","path":"notes/foo.md","fork":"notes/foo-20260726T101500Z.md"}',
    ),
  ).toEqual({
    kind: 'forked',
    path: 'notes/foo.md',
    fork: 'notes/foo-20260726T101500Z.md',
  });
  expect(parseSyncNotice('{"kind":"deletionDropped","path":"notes/foo.md"}')).toEqual({
    kind: 'deletionDropped',
    path: 'notes/foo.md',
  });
});

test('rejects a malformed or incomplete sync notice', () => {
  expect(parseSyncNotice('not json')).toBeNull();
  expect(parseSyncNotice('')).toBeNull();
  // Unknown kind, missing path, or a fork notice with nothing to name.
  expect(parseSyncNotice('{"kind":"rebased","path":"a.md"}')).toBeNull();
  expect(parseSyncNotice('{"kind":"deletionDropped"}')).toBeNull();
  expect(parseSyncNotice('{"kind":"forked","path":"a.md"}')).toBeNull();
  expect(parseSyncNotice('{"kind":"forked","path":"a.md","fork":7}')).toBeNull();
});

test('a sync notice carries no author (the payload is impersonal)', () => {
  const notice = parseSyncNotice(
    '{"kind":"forked","path":"a.md","fork":"a-1.md","author":{"name":"Ada"}}',
  );
  expect(notice).toEqual({ kind: 'forked', path: 'a.md', fork: 'a-1.md' });
  expect(Object.keys(notice!)).toEqual(['kind', 'path', 'fork']);
});

// --- view-state persistence via localStorage --------------------------------

// The bun test runtime has no DOM `localStorage`; install a minimal in-memory
// stand-in so the SSR-guarded persistence path (`typeof localStorage`) runs.
const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

test('loadBundleState returns the fresh default when nothing is stored', async () => {
  localStorage.removeItem('sunstone:bundleState');
  await expect(httpBackend.loadBundleState()).resolves.toEqual({
    lastOpenConcept: null,
    expandedFolders: [],
    recentFiles: [],
  });
});

test('saveBundleState → loadBundleState round-trips through localStorage', async () => {
  const state = {
    lastOpenConcept: 'a.md',
    expandedFolders: ['sub'],
    recentFiles: ['a.md'],
    leftSidebarOpen: false,
  };
  await httpBackend.saveBundleState(state);
  await expect(httpBackend.loadBundleState()).resolves.toEqual(state);
});

test('loadBundleState tolerates corrupt JSON by returning the default', async () => {
  localStorage.setItem('sunstone:bundleState', 'not json{');
  await expect(httpBackend.loadBundleState()).resolves.toEqual({
    lastOpenConcept: null,
    expandedFolders: [],
    recentFiles: [],
  });
  localStorage.removeItem('sunstone:bundleState');
});
