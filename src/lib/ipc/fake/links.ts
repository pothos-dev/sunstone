// Outbound-link extraction + automatic link rewriting on rename/move for the
// fake backend (slice: link-auto-rewrite).
//
// The move/rename rewrite ENGINE is not ported here: `planRewrites` hands the
// in-memory corpus to the wasm `planMoveRewrites` export, which runs the same
// `sunstone_shared::rewrite::moves` engine as native `rename_and_rewrite`
// (ADR 0006 — no divergent TS twin). Inbound links (absolute -> new absolute;
// relative -> recomputed, style preserved), a moved Concept's own relative
// outbound links, folder moves, wikilinks and path-model Embeds all behave
// exactly as on the desktop / web backends.
//
// `outboundLinks` (Backlinks extraction) runs the same shared scans native
// extraction does (`markdownLinkHrefs` / `wikilinkRaws`: fence- and
// code-aware), then resolves each target through the wasm resolvers.
//
// Reads the shared `FILES` state (imported live from `store`, never copied).

import type { OkfMarker, RewriteSummary } from '$lib/types';
import {
  splitFrontmatter,
  markdownLinkHrefs,
  wikilinkRaws,
  resolveLinkIn,
  resolveWikilinkIn,
  planMoveRewrites,
  okfVersionOf,
} from '$lib/wasm/exports';
import { FILES, conceptPaths } from './store';

/**
 * Every `index.md` in the store declaring `okf_version` (OKF v0.2 §12), sorted
 * — the fake's `Backend.listOkfMarkers`, parsed by the same shared kernel the
 * native index runs (`frontmatter::okf_version_of`, via wasm `okfVersionOf`).
 */
export function okfMarkers(): OkfMarker[] {
  const markers: OkfMarker[] = [];
  for (const indexPath of conceptPaths()) {
    if (indexPath !== 'index.md' && !indexPath.endsWith('/index.md')) continue;
    const okfVersion = okfVersionOf(FILES[indexPath]);
    if (okfVersion) markers.push({ indexPath, okfVersion });
  }
  return markers;
}

/**
 * The fake Bundle's path within its git repository — the fake's
 * `Backend.gitPrefix`. It models a Bundle opened at its repository toplevel
 * (it has a commit history: `./git`), so `''`.
 */
export const FAKE_GIT_PREFIX: string | null = '';

/**
 * Extract outbound internal link targets from a Concept's body, resolved.
 *
 * ## The `!`-asymmetry is DELIBERATE (af-1) — site 3 of 3
 *
 * EXTRACTION drops `!`; REWRITE (the shared engine behind `planRewrites`) does not. Do not
 * "restore symmetry" here: an Embed is not a Concept-to-Concept relationship,
 * so it must never create a Backlinks edge — which is what the shared scans
 * guarantee (`markdownLinkHrefs` / `wikilinkRaws` skip `![..](..)` / `![[..]]`).
 * That an Embed's *path* is still rewritten on a move is a different question
 * with a different answer. Twin of
 * `crates/sunstone-native/src/index/links.rs::extract_links` (site 1).
 */
export function outboundLinks(path: string, content: string): string[] {
  const { body } = splitFrontmatter(content);
  const paths = conceptPaths();
  const markers = okfMarkers();
  const targets = new Set<string>();
  for (const href of markdownLinkHrefs(body)) {
    const resolved = resolveLinkIn(path, href, paths, markers, FAKE_GIT_PREFIX);
    if (resolved.kind === 'internal') targets.add(resolved.path);
  }
  // Wikilinks ([[name]]) resolve by name (§1) and also feed backlinks.
  for (const raw of wikilinkRaws(body)) {
    const resolved = resolveWikilinkIn(paths, path, raw);
    if (resolved) targets.add(resolved.path);
  }
  // Drop self-edges (e.g. a pure same-file anchor [[#heading]]).
  targets.delete(path);
  return [...targets];
}

/**
 * Auto-rewrite links for a move of `from`->`to`, planned against the in-memory
 * FILES by the shared wasm engine. Reads content BEFORE the rename (snapshot),
 * so callers MUST call this BEFORE mutating FILES with the rename. Returns the
 * rewrite summary and a map of new-path -> rewritten content to apply AFTER the
 * rename.
 */
export function planRewrites(from: string, to: string): {
  summary: RewriteSummary;
  writes: Map<string, string>;
} {
  const concepts = conceptPaths().map((path) => ({ path, content: FILES[path] }));
  const plan = planMoveRewrites(from, to, concepts);
  return {
    summary: plan.summary,
    writes: new Map(plan.writes.map((w) => [w.path, w.content])),
  };
}
