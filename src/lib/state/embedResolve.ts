// Embed resolution over the Attachment corpus (af-1) — the pure half of
// `index.svelte.ts`'s Embed support, so it can be unit-tested (CLAUDE.md: pure
// logic lives in plain `.ts`; the rune module stays thin over it).
//
// An **Embed** reaches an **Attachment** by one of two models, and they are not
// interchangeable (docs/GLOSSARY.md, ADR-0004):
//
//   * `![alt](./x.png)` resolves by PATH, against the Concept that writes it;
//   * `![[x.png]]`      resolves by NAME, bundle-wide over the Attachment
//     corpus — case-insensitive, literal, partial paths by suffix, ties broken
//     by shortest Bundle path.
//
// Both algorithms live in `sunstone_shared::embed` and reach us through the
// wasm free exports, exactly as link/wikilink resolution does. What lives HERE
// is only the composition: pick the model, hand the name model the corpus, and
// report whether the resolved path is an Attachment we actually hold — which is
// what tells an Embed widget to draw its error placeholder.
//
// The Attachment corpus is SEPARATE from the concept-path set the wasm
// `BundleIndex` handle owns (an Attachment is never a Concept; see the
// Attachment-index note in `crates/sunstone-native/src/index.rs`), which is why
// it is passed in rather than read off the handle.

import { resolveEmbedNameIn, resolveEmbedPathIn } from '$lib/wasm/exports';

/**
 * Which resolution model an Embed uses. Structurally the wasm `EmbedKind`
 * (serialized camelCase), spelled as a literal union so this module does not
 * depend on the generated DTO.
 */
export type EmbedModel = 'path' | 'name';

/** A resolved Embed: the Attachment's bundle path + whether the Bundle holds it. */
export interface EmbedResolution {
  /** Bundle-relative, forward-slash path of the target Attachment. */
  path: string;
  /**
   * Whether an Attachment actually exists there. The name model can only
   * resolve to a real Attachment (`true`); the path model resolves any Bundle
   * path, so `false` here is the broken-Embed case.
   */
  exists: boolean;
}

/** The Attachment path set, with O(1) membership. Build with [`attachmentCorpus`]. */
export interface AttachmentCorpus {
  /** Every Attachment path, sorted — the name model's candidate set. */
  readonly paths: string[];
  /** Membership test for the path model's existence check. */
  has(path: string): boolean;
}

/**
 * The two wasm kernels this module composes, as an injectable seam.
 *
 * Injectable purely so the unit suite can pin the COMPOSITION (model choice,
 * corpus hand-off, existence flag) without standing up wasm — the kernels
 * themselves are single-sourced in Rust and tested there (`shared/src/embed.rs`).
 * Production always takes the default.
 */
export interface EmbedKernels {
  /** `![alt](target)` written in `sourcePath` -> bundle path, or `null`. */
  resolvePath(sourcePath: string, target: string): string | null;
  /** `![[target]]` -> bundle path of the best-matching Attachment, or `null`. */
  resolveName(attachmentPaths: string[], target: string): string | null;
}

/** The shipping kernels: the wasm free exports (they degrade to `null`). */
const WASM_KERNELS: EmbedKernels = {
  resolvePath: resolveEmbedPathIn,
  resolveName: resolveEmbedNameIn,
};

/** Build a corpus from a (sorted) Attachment path list. */
export function attachmentCorpus(paths: string[]): AttachmentCorpus {
  const set = new Set(paths);
  return { paths, has: (path: string) => set.has(path) };
}

/** The empty corpus — SSR, a degraded wasm load, or a backend with no Attachments. */
export const EMPTY_CORPUS: AttachmentCorpus = attachmentCorpus([]);

/**
 * Resolve one Embed's `target` to an Attachment. `null` means "nothing to
 * render": a non-Bundle target (`http:`, `data:`, a pure anchor, empty) for the
 * path model, or no matching Attachment for the name model.
 *
 * Synchronous and total — it is called from a CodeMirror decoration builder,
 * which cannot await, the same reason `resolveLink` / `resolveWikilink` are.
 */
export function resolveEmbedIn(
  corpus: AttachmentCorpus,
  currentPath: string,
  target: string,
  kind: EmbedModel,
  kernels: EmbedKernels = WASM_KERNELS,
): EmbedResolution | null {
  if (kind === 'name') {
    // The name model searches the Attachment corpus, so anything it returns IS
    // an Attachment we hold.
    const path = kernels.resolveName(corpus.paths, target);
    return path === null ? null : { path, exists: true };
  }
  // The path model is corpus-independent: it resolves the written path against
  // the source Concept, and existence is a separate question (an Embed pointing
  // at a path with no Attachment is the broken case the widget must draw).
  const path = kernels.resolvePath(currentPath, target);
  return path === null ? null : { path, exists: corpus.has(path) };
}
