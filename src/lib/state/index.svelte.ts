import { backend } from '$lib/ipc';
import { ensureWasm, type BundleIndex, type ResolvedLink } from '$lib/wasm';
import type { AnchorRename, RootRung } from '$lib/types';

/**
 * The frontend's link-resolution engine (ADR 0006 §3/§4): a thin store over the
 * one wasm `BundleIndex` handle.
 *
 * The handle OWNS the saved concept-path set and runs the SAME Rust algorithms
 * the native backend does — synchronously, in-process — so CodeMirror
 * decorations resolve against the live, unsaved buffer with a single source of
 * truth (no TS twin, no IPC round-trip). `refresh()` rebuilds the handle
 * wholesale (mount / `file-changed` / CRUD), freeing the old one first.
 *
 * The handle is `null` on SSR or when the wasm load degrades (§5): every reader
 * then no-ops (a link resolves to `none`, nothing exists, an anchor rewrite is
 * a pass-through) so styling silently disappears rather than throwing.
 */
class IndexStore {
  /**
   * Bumps on every refresh. A monotonically increasing version that the editor
   * layer subscribes to so it can re-run the (otherwise synchronous) broken-link
   * decoration + wikilink resolution when the index changes.
   */
  version = $state<number>(0);

  /**
   * The wasm `BundleIndex` handle (ADR 0006 §4). `null` on SSR / degrade — the
   * readers below treat that as "no index" and no-op.
   */
  #handle: BundleIndex | null = null;

  /**
   * The **Attachment** corpus (af-1), held BESIDE the handle's concept-path set
   * rather than inside it. An Attachment is never a Concept: folding the two
   * together would put images into quick-nav, the Explorer tree and the
   * structural bundle-root inference (see the Attachment-index note in
   * `crates/sunstone-native/src/index.rs`). The editor needs it synchronously,
   * to resolve `![[name.png]]` while building decorations. Sorted; `[]` on
   * SSR, before the first refresh, or for a backend with no Attachments.
   */
  #attachments: string[] = [];

  /**
   * The user's explicit Bundle root (ov-7), handed to the wasm root finder as
   * rung 0: a bundle-relative folder that skips the detection ladder, or
   * `null` for automatic detection. Set through `setRootOverride`, which App
   * drives from the persisted View state (`session.bundleRootOverride`).
   */
  #rootOverride: string | null = null;

  /**
   * The OKF bundle root within the opened tree (`''` = opened root): the first
   * rung of the root ladder that matches — `okf_version` marker, outermost
   * `index.md`, git toplevel, opened folder (`sunstone-shared/src/bundle_root.rs`)
   * — or the user's override (ov-7), which outranks them all.
   */
  bundleRoot(): string {
    return this.#handle?.bundleRoot() ?? '';
  }

  /**
   * Which rung found the root (`override` when the user set it; else
   * `marker` / `indexChain` / `gitToplevel` / `openedFolder`), or `null` on a
   * null handle. Lets the UI tell an override from a detected root.
   */
  rootRung(): RootRung | null {
    return (this.#handle?.rootRung() as RootRung | undefined) ?? null;
  }

  /**
   * Set (folder path, `''` = the opened folder) or clear (`null`) the user's
   * Bundle-root override and rebuild the handle, so every bundle-absolute link
   * re-resolves from the new root without a reload (the `version` bump re-runs
   * the editor's decorations). A no-op when unchanged.
   */
  async setRootOverride(dir: string | null): Promise<void> {
    if (dir === this.#rootOverride) return;
    this.#rootOverride = dir;
    await this.refresh();
  }

  /**
   * The `okf_version` the Bundle root declares, or `null` when the root was
   * inferred structurally (the Bundle does not declare itself). The gate for
   * OKF-only behaviour (README: "OKF behaviour is gated on the marker").
   */
  okfVersion(): string | null {
    return this.#handle?.okfVersion() ?? null;
  }

  /** Synchronous existence check used by the broken-link decoration. */
  exists(path: string): boolean {
    return this.#handle?.exists(path) ?? false;
  }

  /**
   * Every existing Concept path (bundle-relative). The single source of the
   * membership set — fed to `fuzzy.ts` for quick-nav. `[]` on a null handle.
   */
  conceptPaths(): string[] {
    return this.#handle?.conceptPaths() ?? [];
  }

  /**
   * Every Attachment path (bundle-relative), sorted — the name model's
   * candidate set. `[]` before the first refresh.
   */
  attachmentPaths(): string[] {
    return this.#attachments;
  }

  /**
   * Resolve a clicked markdown link `href` inside the Concept at `currentPath`.
   * The `internal` variant carries `exists`. Degrades to `none` (never throws)
   * on a null handle, so a decoration reader treats it as "not broken".
   */
  resolveLink(currentPath: string, href: string): ResolvedLink {
    return this.#handle?.resolveLink(currentPath, href) ?? { kind: 'none' };
  }

  /**
   * Resolve a raw `[[target]]` inner text to `{ path }`, or `null` (broken).
   * Name-based (ADR-0004); the candidate set stays in-wasm. `null` on a null
   * handle.
   */
  resolveWikilink(currentPath: string, rawTarget: string): { path: string } | null {
    return this.#handle?.resolveWikilink(currentPath, rawTarget) ?? null;
  }

  /**
   * Rewrite same-file anchors in the live editor `body` after a heading-slug
   * rename (body-in / body-out). A pass-through (`{ content: body }`) on a null
   * handle so a save never throws.
   */
  rewriteAnchorsIn(sourcePath: string, body: string, renames: AnchorRename[]): { content: string } {
    return this.#handle?.rewriteAnchorsIn(sourcePath, body, renames) ?? { content: body };
  }

  /** (Re)build the handle from the backend index (ADR 0006 §4/§5). */
  async refresh(): Promise<void> {
    // Ensure the wasm module is initialized before building state. Idempotent +
    // memoized; returns `null` on SSR / load failure, in which case we skip the
    // handle and every reader no-ops (silent degrade).
    const wasm = await ensureWasm();
    try {
      // Both corpora in one round-trip pair: the `.md`-only concept set that
      // backs the handle, and the Attachment set held beside it (they are two
      // separate seam methods because they are two separate indexes — see
      // `Backend.listAttachmentPaths`).
      // The root ladder's filesystem facts ride beside the paths — the
      // `okf_version` markers (OKF v0.2 §12) and the git prefix: the root
      // finder is pure, so they reach it as data.
      const [paths, attachments, markers, gitPrefix] = await Promise.all([
        backend.listConceptPaths(),
        backend.listAttachmentPaths(),
        backend.listOkfMarkers(),
        backend.gitPrefix(),
      ]);
      // Swap the handle: free the OLD one before building the new (ADR 0006
      // §4), only once we have a fresh set — so a backend error leaves the
      // previous handle AND the previous Attachment corpus untouched.
      this.#handle?.free();
      this.#handle = wasm ? new wasm.BundleIndex(paths, markers, gitPrefix, this.#rootOverride) : null;
      this.#attachments = attachments;
      this.version += 1;
    } catch {
      // Index unavailable: leave the previous handle in place. Broken-link
      // styling is best-effort and must never block; a stale set just means a
      // link may briefly look (un)broken until the next refresh.
    }
  }
}

export const indexStore = new IndexStore();
