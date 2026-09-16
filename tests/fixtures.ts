import { test as base, expect, chromium } from '@playwright/test';

/**
 * Test fixtures that auto-detect an ax agent (casket) sandbox and connect over
 * CDP instead of launching a fresh browser.
 *
 * `CASKET_NAME` is only set inside a casket sandbox (see `/casket`'s sessions
 * topic), where the container already runs a Chromium reachable at
 * `http://localhost:9222` — launching a second one either exhausts memory
 * (OOM-killed alongside the `vite build`/preview server) or fails outright
 * (missing shared libs in some images). Reusing the running browser sidesteps
 * both. `PW_CDP` overrides the endpoint explicitly (e.g. a different port);
 * outside a sandbox (CI, a normal host machine) neither is set, so the
 * standard launch path (playwright.config.ts, the host's own Chrome) is used
 * and nothing changes.
 *
 * Specs that need to run in-sandbox import `{ test, expect }` from here instead
 * of directly from `@playwright/test`.
 */
const CDP_ENDPOINT = process.env.PW_CDP ?? (process.env.CASKET_NAME ? 'http://localhost:9222' : undefined);

export const test = CDP_ENDPOINT
  ? base.extend({
      browser: [
        // eslint-disable-next-line no-empty-pattern
        async ({}, use) => {
          const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
          await use(browser);
          // Do NOT close: the browser is shared (it was already running); closing
          // it would tear down the sandbox's browser. Playwright drops the CDP
          // connection when the worker process exits.
        },
        { scope: 'worker' },
      ],
    })
  : base;

export { expect };
export type { Page } from '@playwright/test';
