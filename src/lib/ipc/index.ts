import type { Backend } from './backend';
import { tauriBackend } from './tauri';
import { fakeBackend } from './fake';
import { httpBackend } from './http';
import { servedDesktop } from './served';

export type { Backend } from './backend';

/**
 * Selection of the Backend implementation.
 *
 * Three targets:
 *  - **web** (build-time `__SUNSTONE_WEB__`, set when `SUNSTONE_TARGET=web`):
 *    the HTTP backend talking to `sunstone-server` (open reads, JWT-gated
 *    writes). In this build the
 *    Tauri backend is stubbed out at bundle time (see `vite.config.js`), so
 *    `@tauri-apps/api` never enters the web bundle.
 *  - **desktop**: inside the Tauri webview `__TAURI_INTERNALS__` is present on
 *    `window`, so we use the real IPC-backed impl.
 *  - **served desktop** (`sunstone serve`): the DESKTOP build in a plain
 *    browser, from a server that stamps `window.__SUNSTONE_SERVE__` into
 *    `index.html` (`crates/sunstone-server/src/local.rs`). The HTTP backend
 *    again, now on the same origin as the API with no auth in between.
 *  - **fake**: plain Chromium (vite dev / Playwright) with no Tauri — the
 *    in-memory fixture Bundle.
 *
 * `__SUNSTONE_WEB__` is a build-time constant (replaced by Vite's `define`)
 * so the unused branch is eliminated — the desktop build keeps the exact old
 * behaviour and the web build drops the Tauri path entirely.
 *
 * See docs/architecture/web-frontend.md "The IPC seam".
 */
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const backend: Backend = __SUNSTONE_WEB__
  ? httpBackend
  : isTauri
    ? tauriBackend
    : servedDesktop
      ? httpBackend
      : fakeBackend;

// Expose the selected backend on `window` as a stable test hook (mirrors
// `window.__sunstoneFake` in fake.ts). Playwright reads this instead of
// dynamically importing the source module, so the query specs work against both
// the dev server and a precompiled production build (where `/src/...` paths do
// not exist).
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__sunstoneBackend = backend;
}
