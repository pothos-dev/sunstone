/**
 * The pure decisions behind the same-origin `/api/*` proxy in
 * `src/hooks.server.ts` (WEB build only). The hook does the I/O — resolve the
 * Auth.js session, buffer the request body, `fetch` upstream, stream the
 * response back — and asks this module what to do:
 *
 * - {@link needsAuth}: does this request take the session → mint → forward
 *   branch? Every write (any method but GET/HEAD), plus the gated git reads.
 * - {@link planProxy}: reject (401 not signed in / 503 write auth unconfigured)
 *   or forward with exactly these upstream headers, with or without the body.
 * - {@link responseHeaders}: the headers sent back to the browser, keeping an
 *   SSE stream un-buffered.
 *
 * Security-relevant: this is the write enforcement chokepoint (axum verifies the
 * JWT again, but an unauthenticated write never reaches it). Keep it pure and
 * covered by `apiProxy.test.ts`.
 */

import { mintWriteJwt, type WriteClaims } from './jwt';

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
export const GATED_READS: ReadonlySet<string> = new Set(['/api/history', '/api/file-at-rev']);

/** Any method other than GET/HEAD is a write. */
export function isWrite(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

/** Whether the request needs a valid session (and so a minted JWT). */
export function needsAuth(method: string, pathname: string): boolean {
  return isWrite(method) || GATED_READS.has(pathname);
}

/** The session user as Auth.js hands it over (either field may be missing). */
export type ProxyUser = { name?: string | null; email?: string | null } | null | undefined;

/** Read-only view of the incoming request headers (a `Headers` satisfies it). */
export type RequestHeaderView = { get(name: string): string | null };

export type ProxyPlan =
  | { kind: 'reject'; status: number; body: string }
  | { kind: 'forward'; headers: Record<string, string>; needsBody: boolean };

export type PlanInput = {
  method: string;
  pathname: string;
  reqHeaders: RequestHeaderView;
  /** The session user; only consulted when {@link needsAuth} holds. */
  user: ProxyUser;
  /** `SUNSTONE_JWT_SECRET` ('' when unset). */
  secret: string;
  /** JWT minter; injectable for tests. */
  mint?: (claims: WriteClaims, secret: string) => string;
};

/**
 * Decide how to proxy one `/api/*` request.
 *
 * Reads (GET/HEAD) forward with only `accept` (`text/event-stream` for
 * `/api/events`, else `application/json`). A request that needs auth is
 * rejected 401 without a signed-in user carrying both name and email, then 503
 * when no JWT secret is configured (in that order); otherwise it forwards
 * `authorization: Bearer <jwt>`. A write additionally forwards `content-type`
 * and the per-tab `x-sunstone-client` id when present, and its body — a gated
 * read has no body, so neither.
 */
export function planProxy({
  method,
  pathname,
  reqHeaders,
  user,
  secret,
  mint = mintWriteJwt,
}: PlanInput): ProxyPlan {
  const write = isWrite(method);
  const headers: Record<string, string> = {
    accept: pathname === '/api/events' ? 'text/event-stream' : 'application/json',
  };

  if (needsAuth(method, pathname)) {
    if (!user?.name || !user?.email) {
      return { kind: 'reject', status: 401, body: 'not signed in' };
    }
    if (!secret) {
      // Misconfiguration, not a client error: writing (and, with it, the gated
      // git read seam) is unavailable.
      return { kind: 'reject', status: 503, body: 'write auth is not configured' };
    }
    const jwt = mint({ sub: user.email, name: user.name, email: user.email }, secret);
    headers['authorization'] = `Bearer ${jwt}`;
  }

  if (write) {
    const contentType = reqHeaders.get('content-type');
    if (contentType) headers['content-type'] = contentType;
    // Forward the per-tab client id so the server can stamp the SSE echo.
    const clientId = reqHeaders.get('x-sunstone-client');
    if (clientId) headers['x-sunstone-client'] = clientId;
  }

  return { kind: 'forward', headers, needsBody: write };
}

/**
 * The response headers for an upstream reply: its content-type (default
 * `application/json`), plus `cache-control: no-cache` and `connection:
 * keep-alive` for `text/event-stream` so no intermediary buffers the stream.
 */
export function responseHeaders(upstreamContentType: string | null): Record<string, string> {
  const contentType = upstreamContentType ?? 'application/json';
  const out: Record<string, string> = { 'content-type': contentType };
  if (contentType.includes('text/event-stream')) {
    out['cache-control'] = 'no-cache';
    out['connection'] = 'keep-alive';
  }
  return out;
}
