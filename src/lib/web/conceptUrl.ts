// A Concept's human title for Sunstone Web (pure; no DOM/IPC).
//
// The path↔pretty-URL mapping (`conceptToUrl` / `urlToConcept`) and the tree
// file-set collector (`collectFilePaths`) migrated to Rust in family 13:
// `conceptToUrl` is the wasm free export `conceptToUrl` (single-sourced with the
// native `render.rs` resolved-link href), and `urlToConcept` is the wasm
// `BundleIndex.urlToConcept` handle method (resolving against the concept set the
// handle owns, retiring `collectFilePaths`). What stays TS is the title
// derivation, which reads the `RenderPayload` — no Rust twin (ADR 0006 §3) —
// and `urlToConceptInline`, the SSR-only mirror of `urlToConcept` (see below).

import type { RenderPayload } from './render';
import { stripMd } from '$lib/path';

/**
 * The human title for a Concept, for the document `<title>`: its frontmatter
 * `title`, else its first H1, else a name derived from the path (a folder index
 * uses the folder name). Falls back to `Sunstone Web` when nothing is open.
 */
export function conceptTitle(selected: string | null, rendered: RenderPayload | null): string {
  const fm = rendered?.frontmatter.find((f) => f.key.toLowerCase() === 'title')?.values[0]?.trim();
  if (fm) return fm;
  const h1 = rendered?.outline.find((h) => h.level === 1)?.text.trim();
  if (h1) return h1;
  if (selected) return nameFromPath(selected);
  return 'Sunstone Web';
}

function nameFromPath(path: string): string {
  const parts = stripMd(path).split('/');
  let last = parts.pop() ?? '';
  if (last === 'index') last = parts.pop() ?? ''; // a folder index → the folder name
  return last || 'Sunstone Web';
}

/**
 * Resolve a decoded pretty URL path to a Concept path against `paths` (a folder
 * `index.md` wins over a same-named leaf; empty segments are ignored, so `/`
 * and `''` address the root `index.md`). The TS mirror of Rust
 * `sunstone_shared::url::url_to_concept` (the wasm `BundleIndex.urlToConcept`),
 * used only by the SSR `load`, where wasm is browser-only (ADR 0006 §1/§5) —
 * the ONLY place this rule is duplicated. `conceptUrl.test.ts` pins parity
 * against the shipped wasm.
 */
export function urlToConceptInline(urlPath: string, paths: readonly string[]): string | null {
  const set = new Set(paths);
  const segs = urlPath.split('/').filter(Boolean);
  if (segs.length === 0) return set.has('index.md') ? 'index.md' : null;
  const p = segs.join('/');
  for (const candidate of [`${p}/index.md`, `${p}.md`]) {
    if (set.has(candidate)) return candidate;
  }
  return null;
}
