import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { handle as authHandle } from './auth';
import { mintWriteJwt } from '$lib/server/jwt';

/**
 * Same-origin `/api/*` proxy (WEB build only, adapter-node), now with the
 * authenticated write path (tickets 04/07).
 *
 * The browser-side `http.ts` Backend and SSR `load` fetch relative `/api/...`
 * so there is ONE public origin (the SvelteKit server) and no CORS. This hook
 * forwards to the Rust `sunstone-server` at `SUNSTONE_API_INTERNAL`
 * (default `http://localhost:8787`).
 *
 * READS (GET/HEAD) forward unchanged — no body, no auth (reads are open), with
 * the exception of `GATED_READS` (the git history seam) below.
 * WRITES (any other method) are the enforcement chokepoint: the hook resolves
 * the Auth.js session and, ONLY if valid, mints a short-lived HS256 JWT
 * (`SUNSTONE_JWT_SECRET`) and forwards it as `Authorization: Bearer` alongside
 * the method, body, content-type, and the per-tab `x-sunstone-client` id. axum
 * verifies the JWT itself, so it is self-defending. An unauthenticated write is
 * rejected here with a 401 (axum never sees it).
 *
 * The upstream response BODY is streamed straight through (not buffered), so the
 * SSE `/api/events` stream reaches the browser incrementally. For
 * `text/event-stream` we add `cache-control: no-cache` so no intermediary
 * buffers the stream.
 *
 * In the DEFAULT desktop build (adapter-static SPA) there is no server at
 * runtime, so this hook is never invoked — the static build is unaffected.
 */
const API_INTERNAL = process.env.SUNSTONE_API_INTERNAL ?? 'http://localhost:8787';
const JWT_SECRET = process.env.SUNSTONE_JWT_SECRET ?? '';

/**
 * GET routes that take the session→mint→forward branch anyway (git-sync spec
 * §11): the git read seam. `/api/file-at-rev` returns the full text of any path
 * at any revision — including content deliberately DELETED from the Bundle — so
 * unguarded it would make every version of every file readable by an anonymous
 * visitor; `/api/history` is the index that makes those revisions enumerable, so
 * the two are gated together. The gate IS the write gate (`src/auth.ts`:
 * authenticated == authorized), hence `SUNSTONE_JWT_SECRET` unset ⇒ no history.
 *
 * `http.ts` folds this branch's 401/503 into the seam's `gitMissing`, so a
 * signed-out reader sees the review-diff toggle disabled, not an error.
 */
const GATED_READS = new Set(['/api/history', '/api/file-at-rev']);

const apiProxy: Handle = async ({ event, resolve }) => {
  const { pathname, search } = event.url;
  if (!pathname.startsWith('/api/')) return resolve(event);

  const method = event.request.method;
  const isWrite = method !== 'GET' && method !== 'HEAD';
  // The chokepoint is path-aware: every write, plus the gated git reads.
  const needsAuth = isWrite || GATED_READS.has(pathname);
  const isEvents = pathname === '/api/events';

  const headers: Record<string, string> = {
    accept: isEvents ? 'text/event-stream' : 'application/json',
  };
  let body: string | undefined;

  if (needsAuth) {
    // Enforcement chokepoint: a write (or a gated git read) needs a valid
    // session → a minted JWT.
    const session = await event.locals.auth();
    const user = session?.user;
    if (!user?.name || !user?.email) {
      return new Response('not signed in', { status: 401 });
    }
    if (!JWT_SECRET) {
      // Misconfiguration, not a client error: writing (and, with it, the gated
      // git read seam) is unavailable.
      return new Response('write auth is not configured', { status: 503 });
    }
    const jwt = mintWriteJwt(
      { sub: user.email, name: user.name, email: user.email },
      JWT_SECRET,
    );
    headers['authorization'] = `Bearer ${jwt}`;
  }

  if (isWrite) {
    const contentType = event.request.headers.get('content-type');
    if (contentType) headers['content-type'] = contentType;
    // Forward the per-tab client id so the server can stamp the SSE echo.
    const clientId = event.request.headers.get('x-sunstone-client');
    if (clientId) headers['x-sunstone-client'] = clientId;
    // Write bodies are small JSON — buffer them (no streaming request needed).
    // A gated READ has no body, so this stays write-only.
    body = await event.request.text();
  }

  const upstream = await fetch(`${API_INTERNAL}${pathname}${search}`, {
    method,
    headers,
    body,
    // Let a client abort propagate to the upstream stream (SSE disconnect).
    signal: event.request.signal,
  });

  const contentType = upstream.headers.get('content-type') ?? 'application/json';
  const outHeaders: Record<string, string> = { 'content-type': contentType };
  if (contentType.includes('text/event-stream')) {
    outHeaders['cache-control'] = 'no-cache';
    outHeaders['connection'] = 'keep-alive';
  }
  // Pass the upstream ReadableStream through un-buffered so SSE streams live.
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
};

// Auth.js first (populates `event.locals.auth()` + serves `/auth/*`), then the
// `/api` proxy which depends on the resolved session for writes.
export const handle = sequence(authHandle, apiProxy);
