import { backend } from '$lib/ipc';
import { errMessage } from '$lib/errors';
import { bundle } from '$lib/state/bundle.svelte';
import { editor } from '$lib/state/editor.svelte';
import { indexStore } from '$lib/state/index.svelte';
import { session } from '$lib/state/session.svelte';
import { isReservedFile, reservedStub, type ReservedKind } from '$lib/reserved';
import { scaffoldConcept } from '$lib/frontmatter';
import { moveDestination } from '$lib/path';
import type { RewriteSummary } from '$lib/types';

/**
 * Orchestrates the document-tree CRUD operations (slice: tree-crud).
 *
 * Each action calls the Backend seam, then keeps the UI consistent:
 *  - the tree + broken-link index refresh (the real watcher's `file-changed`
 *    event also drives this, but we refresh here too so the change is PROMPT
 *    and the fake/real paths behave identically — `bundle.load()` is idempotent);
 *  - the open Concept FOLLOWS a rename/move (the watcher's separate
 *    removed/created events cannot convey the from→to mapping, so we do it here
 *    where the mapping is known), and session state is updated to match;
 *  - a deleted open Concept clears the editor gracefully.
 *
 * Last error is surfaced as a rune so the UI can show it.
 */
class TreeActionsStore {
  /** Last failed operation's message, if any (cleared on the next attempt). */
  error = $state<string | null>(null);

  /**
   * WEB-only async pre-op gate for the structural ops that rewrite links across
   * the Bundle (rename/move/delete) — ticket 08 §5. `create` is exempt and never
   * consults it. Given the op + its target path, the gate resolves any dirty
   * active buffer through the three-way Save & continue / Discard & continue /
   * Cancel modal and returns `true` to PROCEED (already Saved/Discarded, or the
   * buffer was clean) or `false` to ABORT the op atomically.
   *
   * `null` by default (DESKTOP): every op is a pass-through, so desktop tree CRUD
   * is byte-identical. Only `WebAppShellIsland` sets it (guarded on
   * `__SUNSTONE_WEB__`).
   */
  beforeStructuralOp:
    | ((op: 'rename' | 'move' | 'delete', target: string) => Promise<boolean>)
    | null = null;

  /** Run the web structural-op gate (pass-through when none is registered). */
  async #gate(op: 'rename' | 'move' | 'delete', target: string): Promise<boolean> {
    return this.beforeStructuralOp ? this.beforeStructuralOp(op, target) : true;
  }

  /**
   * A transient notice surfaced after a rename/move that auto-rewrote links
   * (slice: link-auto-rewrite). The UI shows it briefly so the user knows links
   * were updated on files they did not explicitly open. `null` when there is
   * nothing to show; a monotonic `id` lets the UI re-trigger its auto-dismiss
   * timer even when two consecutive moves produce the same message.
   */
  notice = $state<{ id: number; message: string } | null>(null);
  #noticeSeq = 0;

  /** Refresh the tree + index after a structural change. */
  async #refresh(): Promise<void> {
    await Promise.all([bundle.load(), indexStore.refresh()]);
  }

  /** Wrap an op: clear error, run, refresh, capture failures. */
  async #run(op: () => Promise<void>): Promise<boolean> {
    this.error = null;
    try {
      await op();
      await this.#refresh();
      return true;
    } catch (e) {
      this.error = errMessage(e);
      return false;
    }
  }

  /**
   * Create a new Concept at `path` and open it.
   *
   * Ordinary Concepts open with a spec-valid frontmatter STUB (slice:
   * new-concept-scaffolding): an empty required `type` (the user lands there via
   * the Frontmatter Region) and a `title` humanized from the filename. We compose
   * the stub on the frontend — where the filename is known — and write it via
   * `writeConcept` immediately after the empty file is created, so the backend
   * `createConcept` stays a thin "make an empty .md" op.
   *
   * Reserved files (`index.md`/`log.md`) are EXEMPT from the `type` requirement,
   * so they are NOT given a frontmatter stub — see `createReservedFile`.
   */
  async createConcept(path: string): Promise<boolean> {
    const ok = await this.#run(async () => {
      await backend.createConcept(path);
      if (!isReservedFile(path)) {
        await backend.writeConcept(path, scaffoldConcept(path));
      }
    });
    if (ok) await editor.open(path);
    return ok;
  }

  /**
   * Create a reserved file (`index.md`/`log.md`) in `dir` and open it. Reserved
   * files are created MINIMALLY (a top heading, no `type` stub) since they are
   * exempt from the required-`type` rule. `path` is the full bundle-relative
   * path; `dir`/`kind` derive the heading.
   */
  async createReservedFile(dir: string, kind: ReservedKind, path: string): Promise<boolean> {
    const ok = await this.#run(async () => {
      await backend.createConcept(path);
      await backend.writeConcept(path, reservedStub(dir, kind));
    });
    if (ok) await editor.open(path);
    return ok;
  }

  /** Create a new folder at `path` (and expand it in the tree). */
  async createFolder(path: string): Promise<boolean> {
    const ok = await this.#run(() => backend.createFolder(path));
    if (ok) session.setExpanded(path, true);
    return ok;
  }

  /**
   * Rename/move `from` to `to`. The open Concept follows OPTIMISTICALLY, BEFORE
   * the backend call: the backend's structural change emits a `removed` event
   * for `from`, and if the editor still pointed at `from` when that arrived it
   * would clear itself. Remapping first means the editor already points at `to`,
   * so the `removed` event no longer matches and the editor keeps its content.
   * On failure we roll the open path back.
   */
  async renamePath(from: string, to: string): Promise<boolean> {
    if (!(await this.#gate('rename', from))) return false;
    const before = editor.path;
    this.#followRename(from, to);
    const ok = await this.#run(async () => {
      const summary = await backend.renamePath(from, to);
      this.#showRewriteNotice(summary);
    });
    if (ok) session.followRename(from, to);
    else if (before !== null) this.#followRename(to, before);
    return ok;
  }

  /**
   * The destination path `from` would land at when moved into folder `toDir`
   * (keeps its basename; `''` = Bundle root). Exposed so callers can predict the
   * new path (e.g. to refocus the Explorer there) before awaiting the move.
   */
  resolveMove(from: string, toDir: string): string {
    return moveDestination(from, toDir);
  }

  /** Move `from` into the folder `toDir` (keeping its name), following the open Concept. */
  async movePath(from: string, toDir: string): Promise<boolean> {
    if (!(await this.#gate('move', from))) return false;
    const to = this.resolveMove(from, toDir);
    const before = editor.path;
    this.#followRename(from, to);
    const ok = await this.#run(async () => {
      const summary = await backend.movePath(from, toDir);
      this.#showRewriteNotice(summary);
    });
    if (ok) session.followRename(from, to);
    else if (before !== null) this.#followRename(to, before);
    return ok;
  }

  /**
   * Surface the rewrite notice from OUTSIDE a tree action — used by the editor's
   * slug-anchor rewrite (App.svelte), which auto-rewrites inbound anchors when a
   * heading is renamed and wants the same unobtrusive toast.
   */
  noteRewrite(summary: RewriteSummary): void {
    this.#showRewriteNotice(summary);
  }

  /**
   * Surface a brief notice when a move auto-rewrote links. Nothing is shown when
   * no links changed (the common case), keeping it unobtrusive.
   */
  #showRewriteNotice(summary: RewriteSummary): void {
    if (summary.linksChanged === 0) return;
    const links = summary.linksChanged === 1 ? 'link' : 'links';
    const files = summary.filesChanged === 1 ? 'file' : 'files';
    this.notice = {
      id: ++this.#noticeSeq,
      message: `Updated ${summary.linksChanged} ${links} in ${summary.filesChanged} ${files}`,
    };
  }

  /** Dismiss the rewrite notice (the UI calls this on its auto-dismiss timer). */
  dismissNotice(): void {
    this.notice = null;
  }

  /** Delete `path` (file or folder). A deleted open Concept clears the editor. */
  async deletePath(path: string): Promise<boolean> {
    if (!(await this.#gate('delete', path))) return false;
    return this.#run(() => backend.deletePath(path));
    // The editor clears via App.svelte's `onExternalChange('removed', ...)`
    // wired to the watcher event the fake/real backends both emit on delete.
  }

  /** Apply a rename to the open Concept + history + session. */
  #followRename(from: string, to: string): void {
    const newOpen = editor.followRename(from, to);
    if (newOpen !== null && session.restored) {
      session.setLastOpenConcept(newOpen);
    }
  }
}

export const treeActions = new TreeActionsStore();
