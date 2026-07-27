// URL ⇄ active-Concept reconciliation for the web App shell (pure; no DOM/IPC).
//
// On Sunstone Web the URL must always address the Concept on screen: a reload, a
// copied link and the browser's Back/Forward all have to land on it. That is only
// well-defined with ONE Tile, so the web build hides the split affordances
// (`TileHeader`) and neither restores nor writes the persisted tiling layout
// (`App.svelte`) — the URL, not `localStorage`, decides what is open.
//
// Two sides can move independently, so both are reconciled against a single
// `synced` value — the Concept the URL and the app last agreed on:
//   - the APP moved (tree click, wikilink, Tile Back/Forward, a rename) → write
//     the URL (a shallow `pushState`, which does NOT re-run the route `load`);
//   - the URL moved (browser Back/Forward over those shallow entries, which
//     restores `page.state`) → open that Concept into the Tile.
// Whichever side moved wins and becomes the new `synced`, so the next reconcile
// is idle — the two directions cannot ping-pong.

import { conceptToUrl } from '$lib/wasm/exports';

/**
 * What the sync should do next. `concept` is a bundle-relative Concept path, or
 * `null` for "nothing open" (the Bundle root URL).
 */
export type UrlSyncAction =
  | { kind: 'idle' }
  /** Mark the current history entry with the app's Concept (`replaceState`). */
  | { kind: 'stamp'; concept: string | null }
  /** Write the URL: the app navigated (`pushState`). */
  | { kind: 'url'; concept: string | null }
  /** Open the Concept: the URL navigated (Back/Forward). */
  | { kind: 'app'; concept: string | null };

/**
 * Reconcile the URL side (`urlConcept`, from `page.state`) and the app side
 * (`appConcept`, the active Tile's Concept) against the last agreed `synced`
 * value.
 *
 * `urlConcept === undefined` means the current history entry carries NO Concept
 * of its own — the entry we first landed on (SSR), or one whose `page.state` was
 * wiped by a real navigation (`invalidateAll()` resets it). That is not "the URL
 * moved to nothing": treating it as one would navigate the Tile away from the
 * Concept the user is editing. The entry is stamped from the app side instead —
 * no navigation, no history entry, and Back over it now restores a Concept.
 *
 * `openInFlight` suppresses everything while a URL-driven open is still loading:
 * until it settles the app side legitimately lags behind `synced`, and acting on
 * that gap would push the OLD URL back and undo the user's Back. Once it settles
 * the next reconcile either goes idle (the open landed) or writes the URL back to
 * the Concept that is still open (the dirty-leave gate cancelled it).
 *
 * When both sides moved, the app wins: it is the surface the user just
 * interacted with, and the URL is a projection of it.
 */
export function urlSyncAction(
  synced: string | null,
  urlConcept: string | null | undefined,
  appConcept: string | null,
  openInFlight: boolean,
): UrlSyncAction {
  if (openInFlight) return { kind: 'idle' };
  if (urlConcept === undefined) return { kind: 'stamp', concept: appConcept };
  if (appConcept !== synced) return { kind: 'url', concept: appConcept };
  if (urlConcept !== synced) return { kind: 'app', concept: urlConcept };
  return { kind: 'idle' };
}

/**
 * The pretty URL addressing a Concept — the Bundle root (`/`) when nothing is
 * open. Thin over the wasm `conceptToUrl` free export (single-sourced with the
 * native resolved-link href), which degrades to an equivalent TS fallback before
 * the module registers, so this is safe on the first paint.
 */
export function conceptHref(concept: string | null): string {
  return concept === null ? '/' : conceptToUrl(concept);
}
