// Playwright config for `sunstone serve` — the DESKTOP SPA in a plain browser,
// on the HTTP backend, served by the desktop binary itself (ADR 0012).
//
// The third runner, disjoint from the other two by file name: it owns every
// `serve-*.spec.ts`; the desktop suite `testIgnore`s them and the web suite's
// `web-*` pattern never matches them. It boots the real thing: the static
// desktop build (`bun run build` → `build/`, which a dev `sunstone` binary
// serves from disk) and `cargo run -p sunstone -- serve` over a throwaway git
// copy of the web fixture Bundle. Shares `build/` with both other suites, so
// never run them concurrently.
import { defineConfig, devices } from '@playwright/test';
import { seedFixtureRepo } from './tests/web-bundle';
import { SERVE_BUNDLE_DIR, SERVE_PORT } from './tests/serve-bundle';

// Seeded at module scope, before the server starts watching it (see the note
// on `setupWebBundleRepo` in playwright.web.config.ts).
seedFixtureRepo(SERVE_BUNDLE_DIR, 'main');

export default defineConfig({
  testDir: './tests',
  testMatch: /serve-.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${SERVE_PORT}`,
    trace: 'on-first-retry',
    launchOptions: process.env.CHROMIUM_BIN
      ? { executablePath: process.env.CHROMIUM_BIN, args: ['--no-sandbox'] }
      : undefined,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // `cargo run`, not a hardcoded `target/` path — see playwright.web.config.ts.
    command: `bun run build && cargo run -q -p sunstone -- serve ${SERVE_BUNDLE_DIR} --port ${SERVE_PORT}`,
    url: `http://localhost:${SERVE_PORT}/_api/bundle-root`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
});
