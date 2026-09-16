// Playwright config for the READ-ONLY WEB VIEWER (Sunstone Web).
//
// Unlike the desktop suite (playwright.config.ts, static SPA + in-memory fake),
// the web viewer is architecturally bound to the HTTP backend: it renders only
// in the SSR web build and reads through `/api/*`. So this config boots the
// real read-only stack end-to-end — the `sunstone-server` Rust binary over a
// small committed fixture Bundle (`tests/fixtures/web-bundle`), plus the
// adapter-node SvelteKit server proxying `/api` to it — and drives the viewer
// against that read-only backend (the faithful analog of "the fake backend's
// read-only subset": no write path). The fixture has deterministic content
// (resolvable + broken links, frontmatter, headings) so render assertions hold.
//
// Sandbox note (see CLAUDE.md / `/casket`): inside an ax agent sandbox, launching
// a second Chromium alongside the two servers is unreliable (OOM, or missing
// shared libs depending on the image), so the `tests/fixtures.ts` browser
// fixture auto-detects the sandbox (`CASKET_NAME` is set) and connects over CDP
// to the container's already-running Chromium on :9222 instead. `PW_CDP`
// overrides the endpoint explicitly. Outside a sandbox this is a no-op: the
// launchOptions below apply and Playwright launches a normal local browser
// (override the binary with `CHROMIUM_BIN` if needed).
import { defineConfig, devices } from '@playwright/test';
import {
  WEB_BUNDLE_DIR,
  TEST_JWT_SECRET,
  TEST_AUTH_SECRET,
  TEST_AUTH_NAME,
  TEST_AUTH_EMAIL,
} from './tests/web-bundle';

// The Rust API port. Overridable because 8787 is a popular default and a
// developer machine may already have something on it — the suite then fails at
// "webServer was not able to start" with a bind error that looks like a Sunstone
// bug rather than a busy port.
const RUST_PORT = Number(process.env.SUNSTONE_TEST_API_PORT ?? 8787);
const WEB_PORT = 5199;

export default defineConfig({
  testDir: './tests',
  // The web e2e suite owns every `web-*.spec.ts` (ticket 09): the read-only
  // `web-viewer` spec plus the forthcoming `web-write` / `web-concurrency`
  // specs. The desktop runner `testIgnore`s the same pattern, keeping the two
  // suites disjoint (each spec belongs to exactly one runner).
  testMatch: /web-.*\.spec\.ts$/,
  // Build the throwaway seeded git-repo fixture (temp copy) before the servers
  // boot, so a web Save lands a real commit without polluting the outer repo.
  globalSetup: './tests/global-setup.web.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'on-first-retry',
    // These only matter when the CDP auto-detect in tests/fixtures.ts is a
    // no-op (i.e. outside an ax agent sandbox): CHROMIUM_BIN overrides the
    // binary Playwright launches; unset, it uses the normal host launch path.
    launchOptions: process.env.CHROMIUM_BIN
      ? { executablePath: process.env.CHROMIUM_BIN, args: ['--no-sandbox'] }
      : undefined,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // The Rust API server over the seeded git-repo fixture (the temp copy
      // built by global-setup, NOT the in-repo fixture). `SUNSTONE_JWT_SECRET`
      // enables the write routes; axum verifies write JWTs against it, so it
      // MUST match the secret the SvelteKit hook mints with (below).
      command: `cargo build -p sunstone-server && SUNSTONE_BUNDLE=${WEB_BUNDLE_DIR} SUNSTONE_API_PORT=${RUST_PORT} SUNSTONE_JWT_SECRET=${TEST_JWT_SECRET} ./target/debug/sunstone-server`,
      url: `http://localhost:${RUST_PORT}/api/bundle-root`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      // The SSR web build (adapter-node, default `build/` out), proxying /api to
      // the Rust server. `reuseExistingServer` lets a pre-started server be
      // reused (needed in sandboxes that protect in-repo build dirs — build to a
      // temp dir and start it by hand, then Playwright reuses it on this port).
      //
      // Auth chain (ticket 09): `SUNSTONE_TEST_AUTH=1` enables the env-gated test
      // Credentials provider (src/auth.ts) yielding the fixed identity below;
      // `AUTH_SECRET` signs the Auth.js session; `SUNSTONE_JWT_SECRET` (shared
      // with the Rust server) is what the hook mints the write JWT with. Together
      // they make the real session → hook → JWT → axum write chain run live.
      command: `SUNSTONE_TARGET=web bun run build && PORT=${WEB_PORT} SUNSTONE_API_INTERNAL=http://localhost:${RUST_PORT} SUNSTONE_TEST_AUTH=1 SUNSTONE_JWT_SECRET=${TEST_JWT_SECRET} AUTH_SECRET=${TEST_AUTH_SECRET} SUNSTONE_TEST_AUTH_NAME='${TEST_AUTH_NAME}' SUNSTONE_TEST_AUTH_EMAIL='${TEST_AUTH_EMAIL}' node build/index.js`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
