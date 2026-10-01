/**
 * Whether this page is the DESKTOP build served to a plain browser by
 * `sunstone serve` — which stamps `window.__SUNSTONE_SERVE__` into every
 * `index.html` it serves (`crates/sunstone-server/src/local.rs`). `false` under
 * SSR, in the Tauri webview, in the web build and in vite dev / Playwright.
 *
 * Read by `index.ts` (backend selection) and `http.ts` (the per-Bundle View
 * state key: one `sunstone serve` origin can serve different Bundles over time).
 */
export const servedDesktop = typeof window !== 'undefined' && '__SUNSTONE_SERVE__' in window;
