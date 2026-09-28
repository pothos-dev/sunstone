import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { handle as authHandle } from './auth';
import { needsAuth, planProxy, responseHeaders } from '$lib/server/apiProxy';

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
 * the exception of `GATED_READS` (the git history seam, see `apiProxy.ts`).
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
 * The decisions (which requests need auth, the 401/503 rejections, which
 * headers go upstream and back) live in the pure, unit-tested
 * `$lib/server/apiProxy`; this hook is only the I/O around them.
 *
 * In the DEFAULT desktop build (adapter-static SPA) there is no server at
 * runtime, so this hook is never invoked — the static build is unaffected.
 */
const API_INTERNAL = process.env.SUNSTONE_API_INTERNAL ?? 'http://localhost:8787';
const JWT_SECRET = process.env.SUNSTONE_JWT_SECRET ?? '';

const apiProxy: Handle = async ({ event, resolve }) => {
  const { pathname, search } = event.url;
  if (!pathname.startsWith('/api/')) return resolve(event);

  const method = event.request.method;
  // Resolve the session only when the request needs it (every write, plus the
  // gated history reads).
  const user = needsAuth(method, pathname) ? (await event.locals.auth())?.user : undefined;
  const plan = planProxy({
    method,
    pathname,
    reqHeaders: event.request.headers,
    user,
    secret: JWT_SECRET,
  });
  if (plan.kind === 'reject') return new Response(plan.body, { status: plan.status });

  const upstream = await fetch(`${API_INTERNAL}${pathname}${search}`, {
    method,
    headers: plan.headers,
    // Write bodies are small JSON — buffer them (no streaming request needed).
    body: plan.needsBody ? await event.request.text() : undefined,
    // Let a client abort propagate to the upstream stream (SSE disconnect).
    signal: event.request.signal,
  });

  // Pass the upstream ReadableStream through un-buffered so SSE streams live.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders(upstream.headers.get('content-type')),
  });
};

// Auth.js first (populates `event.locals.auth()` + serves `/auth/*`), then the
// `/api` proxy which depends on the resolved session for writes.
export const handle = sequence(authHandle, apiProxy);
