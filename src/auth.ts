/**
 * Auth.js (`@auth/sveltekit`) configuration for the web build (ticket 04).
 *
 * Provider-agnostic OAuth/OIDC: any provider that returns `name` + `email` works
 * (GitHub, Google, a generic OIDC provider, or Dex fronting LDAP/password). The
 * operator wires the real provider from env; the app only ever speaks OAuth, so
 * the OIDC `name`/`email` claims become the git commit author for free — no
 * user→identity mapping table. **Authenticated == authorized** (ticket 04 §6):
 * scoping to the known users is a deployment responsibility (a private provider).
 *
 * A generic OIDC provider is added when `SUNSTONE_OIDC_ISSUER` + client
 * credentials are present. A **test-only** Credentials provider is added ONLY
 * when `SUNSTONE_TEST_AUTH=1` (off in every real build) so the e2e suite can log
 * in through the real session→hook→JWT→axum chain without a live IdP (ticket 09).
 *
 * This module is only loaded by the Node (web) server hook; the desktop
 * adapter-static build never runs it.
 */

import { SvelteKitAuth, type SvelteKitAuthConfig } from '@auth/sveltekit';
import Credentials from '@auth/sveltekit/providers/credentials';

/** Whether the env-gated test Credentials provider is enabled. */
const testAuthEnabled = process.env.SUNSTONE_TEST_AUTH === '1';

/** Build the provider list from the environment (see module docs). */
function providers(): SvelteKitAuthConfig['providers'] {
  const list: SvelteKitAuthConfig['providers'] = [];

  // Generic OIDC — the production shape (Dex/Google/etc. behind one config).
  const issuer = process.env.SUNSTONE_OIDC_ISSUER;
  const clientId = process.env.SUNSTONE_OIDC_CLIENT_ID;
  const clientSecret = process.env.SUNSTONE_OIDC_CLIENT_SECRET;
  if (issuer && clientId && clientSecret) {
    list.push({
      id: 'oidc',
      name: process.env.SUNSTONE_OIDC_NAME ?? 'Single sign-on',
      type: 'oidc',
      issuer,
      clientId,
      clientSecret,
    });
  }

  // Test-only fixed identity — MUST stay env-gated so it can never ship enabled.
  if (testAuthEnabled) {
    list.push(
      Credentials({
        id: 'test',
        name: 'Test sign-in',
        credentials: {},
        authorize: () => ({
          id: 'test-user',
          name: process.env.SUNSTONE_TEST_AUTH_NAME ?? 'Test User',
          email: process.env.SUNSTONE_TEST_AUTH_EMAIL ?? 'test@example.com',
        }),
      }),
    );
  }

  return list;
}

export const { handle, signIn, signOut } = SvelteKitAuth({
  // One shared secret for the session cookie (Auth.js requirement). Distinct
  // from SUNSTONE_JWT_SECRET (the hook→axum write token).
  secret: process.env.AUTH_SECRET,
  // Behind the `/api`/reverse proxy the Host header is trusted by the operator.
  trustHost: true,
  providers: providers(),
  // Cookie hardening (ticket 04 §7): HttpOnly + SameSite=Lax + Secure in prod;
  // combined with SvelteKit's built-in Origin check this covers cookie-CSRF.
  session: { strategy: 'jwt' },
  callbacks: {
    // Carry name+email onto the session so the `/api` hook can mint the write
    // JWT and so the page can decide whether to show the Edit affordance.
    async session({ session, token }) {
      if (session.user) {
        session.user.name = (token.name as string | undefined) ?? session.user.name;
        session.user.email = (token.email as string | undefined) ?? session.user.email;
        // Carry the OIDC `picture` claim (if any) so the UI can show a real
        // avatar; falls back to initials when the provider gives none.
        session.user.image = (token.picture as string | undefined) ?? session.user.image;
      }
      return session;
    },
  },
});
