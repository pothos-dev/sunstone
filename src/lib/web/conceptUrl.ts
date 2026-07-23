// A Concept's human title for Sunstone Web (pure; no DOM/IPC).
//
// The path↔pretty-URL mapping (`conceptToUrl` / `urlToConcept`) and the tree
// file-set collector (`collectFilePaths`) migrated to Rust in family 13:
// `conceptToUrl` is the wasm free export `conceptToUrl` (single-sourced with the
// native `render.rs` resolved-link href), and `urlToConcept` is the wasm
// `BundleIndex.urlToConcept` handle method (resolving against the concept set the
// handle owns, retiring `collectFilePaths`). What stays TS is the title
// derivation, which reads the `RenderPayload` — no Rust twin (ADR 0006 §3).

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
