/**
 * Synchronous, handle-less wasm FREE exports (ADR 0006 §3, family 11+).
 *
 * These are the per-call kernels (content-in / struct-out) that don't need the
 * `BundleIndex` handle: frontmatter split / line-count / parse. They must be
 * callable SYNCHRONOUSLY (the editor's Property model + the outline scan run in
 * that mode), so this module keeps a memoized reference to the initialized wasm
 * module and reads it per call — the free-export analogue of `indexStore`'s
 * handle (family 10).
 *
 * Deliberately FREE of the `$app/environment` import that `./index.ts` carries:
 * the browser loader (`ensureWasm`) and the `bun test` preload both register the
 * module here via `setWasmModule`, so bun-reachable consumers (the property
 * model, the fake backend, the outline) can import these kernels without
 * dragging the SvelteKit-only `$app` virtual module into the unit-test graph.
 *
 * Before the module is registered (SSR, a degraded load, or the very first
 * frame) every wrapper returns a SAFE no-op default — "no frontmatter" — exactly
 * as family 10's readers no-op on a null handle; the `version` rune re-runs once
 * wasm is ready.
 */

import type {
  SplitConcept,
  FrontmatterField,
  IndexFrontmatter,
  OutlineHeading,
  CriticMark,
  CriticMarkKind,
  Annotation,
  CitationRef,
  ResolvedLink,
  WikilinkTarget,
  WikilinkParts,
  AnchorRewrite,
  AnchorRename,
} from '$lib/wasm/pkg';

/** The generated wasm DTOs, surfaced for consumers (ADR 0006 §6). */
export type {
  SplitConcept,
  FrontmatterField,
  IndexFrontmatter,
  OutlineHeading,
  CriticMark,
  CriticMarkKind,
  Annotation,
  CitationRef,
  ResolvedLink,
  WikilinkTarget,
  WikilinkParts,
  AnchorRewrite,
};

/** The wasm module namespace (`BundleIndex` + the free exports). */
type WasmModule = typeof import('$lib/wasm/pkg');

/** The one memoized, initialized wasm module (or `null` until registered). */
let mod: WasmModule | null = null;

/**
 * Register the initialized wasm module so the synchronous free-export wrappers
 * below can reach it. Called by the browser loader (`ensureWasm`) after
 * `init()`, and by the `bun test` preload after `initSync()`. Pass `null` to
 * clear (degrade).
 */
export function setWasmModule(m: WasmModule | null): void {
  mod = m;
}

/**
 * Split raw Concept markdown into its leading frontmatter block + body (verbatim
 * `open`/`yaml`/`close`/`body` slices, so an unchanged document recombines
 * byte-for-byte). Degrades to "no frontmatter" (whole content is body).
 */
export function splitFrontmatter(content: string): SplitConcept {
  return mod
    ? mod.splitFrontmatter(content)
    : { hasFrontmatter: false, yaml: '', body: content, open: '', close: '' };
}

/**
 * Number of leading lines the frontmatter block occupies (0 when none) — the
 * full-document ↔ body-relative line offset the editor view applies.
 */
export function frontmatterLineCount(content: string): number {
  return mod ? mod.frontmatterLineCount(content) : 0;
}

/** The `type` scalar + `tags` flat list from a Concept's frontmatter. */
export function parseFrontmatter(content: string): IndexFrontmatter {
  return mod ? mod.parseFrontmatter(content) : { type: null, tags: [] };
}

/** The distinct top-level frontmatter keys of a Concept. */
export function parseFrontmatterKeys(content: string): string[] {
  return mod ? mod.parseFrontmatterKeys(content) : [];
}

/** Every top-level frontmatter entry as `key` + value(s), in document order. */
export function parseFrontmatterFields(content: string): FrontmatterField[] {
  return mod ? mod.parseFrontmatterFields(content) : [];
}

// --- Render-derived free exports (ADR 0006 §3, family 13) -------------------
//
// The pure kernels behind the editor's Outline, CriticMarkup decorations and
// citation superscripts — offset-span structs (the CM-decoration seam) + the
// outline enumeration. Native `render.rs` consumes the SAME shared functions, so
// there is one algorithm for the editor and the SSR render. Each degrades to a
// SAFE empty/null default until the module is registered (SSR / first frame /
// degraded load); the `version` rune re-runs decorations once wasm is ready.

/** Scan raw markdown for its body headings (ATX only), in document order. */
export function scanHeadings(content: string): OutlineHeading[] {
  return mod ? mod.scanHeadings(content) : [];
}

/** Full-document line of the first heading whose slug matches `anchor`, or null. */
export function findHeadingLine(content: string, anchor: string): number | null {
  return mod ? (mod.findHeadingLine(content, anchor) ?? null) : null;
}

/** Every CriticMarkup mark in the doc, in document order (offset-span structs). */
export function parseCriticMarks(doc: string): CriticMark[] {
  return mod ? mod.parseCriticMarks(doc) : [];
}

/** Group CriticMarkup marks into highlight+comment annotations. */
export function pairAnnotations(marks: CriticMark[]): Annotation[] {
  return mod ? mod.pairAnnotations(marks) : [];
}

/** The annotation whose overall span contains `pos` (caret between chars), or null. */
export function annotationAt(annotations: Annotation[], pos: number): Annotation | null {
  return mod ? (mod.annotationAt(annotations, pos) ?? null) : null;
}

/** Every inline citation reference (a `[n]` following a word) in `text`. */
export function findCitationRefs(text: string): CitationRef[] {
  return mod ? mod.findCitationRefs(text) : [];
}

/** Offset of citation `num`'s definition row (line-start `[num]`), or null. */
export function citationDefPos(text: string, num: string): number | null {
  return mod ? (mod.citationDefPos(text, num) ?? null) : null;
}

/**
 * A Concept's bundle path → its pretty viewer URL pathname (drops `.md` and a
 * trailing `/index`; root `index.md` → `/`). Single-sourced with the native
 * `render.rs` resolved-link href. The degrade fallback inlines the same rule so
 * client navigation still works if wasm fails to load (ADR 0006 §5) — the ONLY
 * place this logic is duplicated, and only on the degraded path.
 */
export function conceptToUrl(path: string): string {
  if (mod) return mod.conceptToUrl(path);
  let p = path.replace(/\.md$/i, '');
  if (p === 'index') return '/';
  if (p.endsWith('/index')) p = p.slice(0, -'/index'.length);
  return '/' + p.split('/').map(encodeURIComponent).join('/');
}

// --- Free link-family exports for the fake backend (ADR 0006 family 12) -----
//
// The fake backend's Layer-2 rename/move orchestration (twin of the NATIVE
// rename command) resolves + rewrites over arbitrary OLD/NEW corpus path-sets
// with `target != source` — a shape the live `BundleIndex` handle does not
// expose. These handle-less kernels run the SAME shared Rust source over an
// explicit path-set, so the fake consumes the single source (no forked TS
// re-impl). Each degrades to a SAFE no-op until the module is registered; the
// fake backend only runs after wasm has initialized (bun preload / browser
// `ensureWasm`).

/**
 * Resolve a markdown link `href` from `currentPath` against an explicit concept
 * path-set (the fake's corpus). Degrades to `none`.
 */
export function resolveLinkIn(currentPath: string, href: string, paths: string[]): ResolvedLink {
  return mod ? mod.resolveLinkIn(currentPath, href, paths) : { kind: 'none' };
}

/**
 * Resolve a raw `[[target]]` inner text against an explicit concept path-set, or
 * `null` (broken). Degrades to `null`.
 */
export function resolveWikilinkIn(
  paths: string[],
  sourcePath: string,
  rawTarget: string,
): WikilinkTarget | null {
  return mod ? (mod.resolveWikilinkIn(paths, sourcePath, rawTarget) ?? null) : null;
}

/**
 * Split a raw `[[ ... ]]` inner text into `{ name, alias, anchor }` (single
 * source `wikilink::parse_target`). `alias`/`anchor` are normalized to `null`
 * when absent so callers can test them with `!== null`. Degrades to a bare name.
 */
export function splitWikilinkTarget(rawTarget: string): WikilinkParts {
  const p = mod ? mod.splitWikilinkTarget(rawTarget) : null;
  return {
    name: p ? p.name : rawTarget,
    alias: p?.alias ?? null,
    anchor: p?.anchor ?? null,
  };
}

/**
 * Corpus-wide anchor rewrite (`target != source`): rewrite every inbound link's
 * `#anchor` in `content` that resolves to `target` and whose slug matches a
 * rename. Returns `{ content, count }`. Degrades to a no-op (content unchanged).
 */
export function rewriteAnchors(
  source: string,
  content: string,
  target: string,
  renames: AnchorRename[],
  paths: string[],
): AnchorRewrite {
  return mod
    ? mod.rewriteAnchors(source, content, target, renames, paths)
    : { content, count: 0 };
}
