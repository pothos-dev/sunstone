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

import type { SplitConcept, FrontmatterField, IndexFrontmatter } from '$lib/wasm/pkg';

/** The generated wasm DTOs, surfaced for consumers (ADR 0006 §6). */
export type { SplitConcept, FrontmatterField, IndexFrontmatter };

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
