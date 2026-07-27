// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      /** Resolved Auth.js session accessor (web build; populated by the auth
       * hook). The `/api` proxy uses it to gate + attribute writes. */
      auth(): Promise<import('@auth/sveltekit').Session | null>;
    }
    // interface PageData {}
    interface PageState {
      /**
       * WEB build: the bundle-relative Concept path the current history entry
       * addresses (`null` = the Bundle root with nothing open). The App shell
       * keeps it in step with the single Tile via shallow `pushState`, so
       * Back/Forward re-open a Concept without re-running the route `load` (see
       * `src/lib/web/urlSync.ts`).
       */
      concept?: string | null;
    }
    // interface Platform {}
  }

  /**
   * Build-time target flag, replaced by Vite's `define` (see `vite.config.js`).
   * `true` for the "Sunstone Web" build (`SUNSTONE_TARGET=web`), `false` for the
   * default desktop/Tauri build. The IPC seam and adapter selection branch on it;
   * because it is a compile-time constant, the unused branch is eliminated.
   */
  const __SUNSTONE_WEB__: boolean;
}

export {};
