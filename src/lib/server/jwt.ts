/**
 * Mint the short-lived HS256 JWT the `/_api` hook forwards to `sunstone-server`
 * on a write (tickets 04 §4 / 07 §3). Server-side only (node:crypto): the token
 * lives on the hook → axum hop and never reaches the browser.
 *
 * The wire format is exactly what the Rust `auth::verify` expects:
 * `base64url(header).base64url(payload).base64url(HMAC-SHA256(signing_input))`,
 * header `{"alg":"HS256","typ":"JWT"}`. We hand-roll it over `node:crypto`
 * rather than pull `jose`, keeping a single tiny issuer that mirrors the
 * verifier byte-for-byte.
 */

import { createHmac } from 'node:crypto';

/** Claims carried in the write JWT (must match the Rust `Claims` struct). */
export type WriteClaims = {
  sub: string;
  name: string;
  email: string;
};

/** base64url (no padding) encode a buffer or string. */
function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Mint an HS256 JWT for `claims`, valid for `ttlSeconds` (default 60s), signed
 * with `secret`. `nowSeconds` is injectable for deterministic tests; it defaults
 * to the wall clock.
 */
export function mintWriteJwt(
  claims: WriteClaims,
  secret: string,
  ttlSeconds = 60,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      sub: claims.sub,
      name: claims.name,
      email: claims.email,
      iat: nowSeconds,
      exp: nowSeconds + ttlSeconds,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}
