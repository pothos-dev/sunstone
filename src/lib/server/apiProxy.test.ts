import { describe, test, expect } from 'bun:test';
import { createHmac } from 'node:crypto';
import { GATED_READS, needsAuth, planProxy, responseHeaders, type PlanInput } from './apiProxy';

const USER = { name: 'Ada Lovelace', email: 'ada@example.com' };
const fakeMint = (c: { sub: string; name: string; email: string }, s: string) =>
  `jwt(${c.sub}|${c.name}|${c.email}|${s})`;

function plan(over: Partial<PlanInput> & { headers?: Record<string, string> } = {}) {
  const { headers = {}, ...rest } = over;
  return planProxy({
    method: 'GET',
    pathname: '/api/tree',
    reqHeaders: new Headers(headers),
    user: undefined,
    secret: 'sekrit',
    mint: fakeMint,
    ...rest,
  });
}

describe('needsAuth', () => {
  test('plain GET/HEAD reads are open', () => {
    expect(needsAuth('GET', '/api/tree')).toBe(false);
    expect(needsAuth('HEAD', '/api/concept')).toBe(false);
    expect(needsAuth('GET', '/api/events')).toBe(false);
  });

  test('every non-GET/HEAD method is a write and needs auth', () => {
    for (const m of ['PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS', 'get']) {
      expect(needsAuth(m, '/api/concept')).toBe(true);
    }
  });

  test('the git read seam is gated on GET and HEAD', () => {
    expect([...GATED_READS].sort()).toEqual(['/api/file-at-rev', '/api/history']);
    for (const p of GATED_READS) {
      expect(needsAuth('GET', p)).toBe(true);
      expect(needsAuth('HEAD', p)).toBe(true);
    }
  });

  test('gating matches the exact pathname only', () => {
    expect(needsAuth('GET', '/api/history/')).toBe(false);
    expect(needsAuth('GET', '/api/historyx')).toBe(false);
  });
});

describe('planProxy — open reads', () => {
  test('forward with only a JSON accept, no body, no auth, session ignored', () => {
    expect(plan({ user: USER })).toEqual({
      kind: 'forward',
      headers: { accept: 'application/json' },
      needsBody: false,
    });
  });

  test('a read forwards even with no user and no secret', () => {
    expect(plan({ secret: '' })).toEqual({
      kind: 'forward',
      headers: { accept: 'application/json' },
      needsBody: false,
    });
  });

  test('/api/events asks for an event stream', () => {
    expect(plan({ pathname: '/api/events' })).toEqual({
      kind: 'forward',
      headers: { accept: 'text/event-stream' },
      needsBody: false,
    });
  });

  test('client headers are NOT forwarded on a read', () => {
    const p = plan({
      headers: { 'content-type': 'text/plain', 'x-sunstone-client': 'tab-1', authorization: 'Bearer evil' },
    });
    expect(p).toEqual({ kind: 'forward', headers: { accept: 'application/json' }, needsBody: false });
  });
});

describe('planProxy — auth rejections', () => {
  test('a write without a session is 401', () => {
    expect(plan({ method: 'PUT' })).toEqual({ kind: 'reject', status: 401, body: 'not signed in' });
  });

  test('a user missing name or email is 401', () => {
    for (const user of [null, {}, { name: 'A' }, { email: 'a@b' }, { name: '', email: 'a@b' }, { name: 'A', email: null }]) {
      expect(plan({ method: 'POST', user })).toEqual({ kind: 'reject', status: 401, body: 'not signed in' });
    }
  });

  test('a gated read without a session is 401', () => {
    expect(plan({ pathname: '/api/history' })).toEqual({ kind: 'reject', status: 401, body: 'not signed in' });
    expect(plan({ pathname: '/api/file-at-rev' })).toEqual({ kind: 'reject', status: 401, body: 'not signed in' });
  });

  test('401 wins over 503: no session and no secret is still 401', () => {
    expect(plan({ method: 'DELETE', secret: '' })).toEqual({ kind: 'reject', status: 401, body: 'not signed in' });
  });

  test('a signed-in write with no secret configured is 503', () => {
    expect(plan({ method: 'PUT', user: USER, secret: '' })).toEqual({
      kind: 'reject',
      status: 503,
      body: 'write auth is not configured',
    });
    expect(plan({ pathname: '/api/history', user: USER, secret: '' })).toEqual({
      kind: 'reject',
      status: 503,
      body: 'write auth is not configured',
    });
  });
});

describe('planProxy — authorised forwards', () => {
  test('a write forwards bearer + content-type + client id and needs the body', () => {
    const p = plan({
      method: 'PUT',
      user: USER,
      headers: { 'content-type': 'application/json', 'x-sunstone-client': 'tab-7', cookie: 'c=1' },
    });
    expect(p).toEqual({
      kind: 'forward',
      headers: {
        accept: 'application/json',
        authorization: 'Bearer jwt(ada@example.com|Ada Lovelace|ada@example.com|sekrit)',
        'content-type': 'application/json',
        'x-sunstone-client': 'tab-7',
      },
      needsBody: true,
    });
  });

  test('a write omits absent content-type / client id', () => {
    expect(plan({ method: 'POST', user: USER })).toEqual({
      kind: 'forward',
      headers: {
        accept: 'application/json',
        authorization: 'Bearer jwt(ada@example.com|Ada Lovelace|ada@example.com|sekrit)',
      },
      needsBody: true,
    });
  });

  test('a gated read forwards the bearer but no client headers and no body', () => {
    const p = plan({
      pathname: '/api/file-at-rev',
      user: USER,
      headers: { 'content-type': 'application/json', 'x-sunstone-client': 'tab-7' },
    });
    expect(p).toEqual({
      kind: 'forward',
      headers: {
        accept: 'application/json',
        authorization: 'Bearer jwt(ada@example.com|Ada Lovelace|ada@example.com|sekrit)',
      },
      needsBody: false,
    });
  });

  test('defaults to the real HS256 minter keyed with the secret', () => {
    const p = planProxy({
      method: 'PUT',
      pathname: '/api/concept',
      reqHeaders: new Headers(),
      user: USER,
      secret: 'sekrit',
    });
    if (p.kind !== 'forward') throw new Error('expected forward');
    const token = p.headers.authorization.replace(/^Bearer /, '');
    const [h, payload, sig] = token.split('.');
    expect(sig).toBe(createHmac('sha256', 'sekrit').update(`${h}.${payload}`).digest('base64url'));
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    expect(claims).toMatchObject({ sub: USER.email, name: USER.name, email: USER.email });
    expect(claims.exp - claims.iat).toBe(60);
  });
});

describe('responseHeaders', () => {
  test('passes the upstream content-type through', () => {
    expect(responseHeaders('text/html; charset=utf-8')).toEqual({ 'content-type': 'text/html; charset=utf-8' });
  });

  test('defaults to JSON when upstream sends none', () => {
    expect(responseHeaders(null)).toEqual({ 'content-type': 'application/json' });
  });

  test('keeps an SSE stream un-buffered', () => {
    expect(responseHeaders('text/event-stream; charset=utf-8')).toEqual({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
  });
});
