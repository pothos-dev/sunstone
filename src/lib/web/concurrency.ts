/**
 * Pure client-side decision logic for the web write concurrency UX (ticket 08).
 *
 * Kept as plain `.ts` (the repo's "pure logic lives in `.ts`" convention) so it
 * is unit-testable under `bun test src/lib`; the editor-island `.svelte` glue
 * stays thin over these helpers. Two concerns live here:
 *   - the per-tab `clientId` echo filter (drop the SSE echo of our own write);
 *   - routing a genuine `FileChange` against the open buffer (added in the
 *     concurrency-UX wiring slice).
 */

import type { FileChange } from '$lib/types';

/**
 * Whether `change` is the echo of THIS tab's own write, i.e. the server stamped
 * it with our `clientId`. Such echoes carry no new information (we already have
 * the content) and must be dropped before any buffer/refresh routing, while
 * every OTHER client treats the same change as genuine (ticket 08 §1).
 */
export function isOwnEcho(change: FileChange, myClientId: string): boolean {
  return change.origin?.clientId === myClientId;
}

/**
 * What the editor shell should do in response to a genuine (non-echo)
 * `FileChange` (ticket 08 §2–3). Discriminated so the `.svelte` glue is a thin
 * `switch`:
 *   - `refresh`   — the change touched only OTHER files: refresh the read-only
 *                   surfaces (tree, backlinks, tags); the buffer is untouched.
 *   - `reload`    — the active Concept changed under a CLEAN buffer: silently
 *                   reload from disk + show an "Updated by <author>" notice.
 *   - `conflict`  — the active Concept changed under a DIRTY buffer: raise the
 *                   blocking discard-vs-keep modal.
 *   - `deleted`   — the active Concept was removed (remote delete, or a remote
 *                   rename which surfaces as `removed(old)`): drop to the
 *                   deleted state (a dirty buffer is recreatable via Save).
 * `author` is the attributed writer name (from `origin`), or `null` for an
 * external/desktop edit ("changed on disk").
 */
export type ChangeAction =
  | { type: 'refresh' }
  | { type: 'reload'; author: string | null }
  | { type: 'conflict'; author: string | null }
  | { type: 'deleted'; author: string | null; dirty: boolean };

/**
 * Route a genuine `FileChange` against the open buffer (ticket 08 §2). `change`
 * must already have passed the {@link isOwnEcho} filter. `activePath` is the open
 * Concept's bundle-relative path (or `null` when nothing is open); `dirty` is
 * whether the active buffer has unsaved edits. A `created` on the active path is
 * treated as `modified` (ticket 08 §2).
 */
export function routeFileChange(
  change: FileChange,
  activePath: string | null,
  dirty: boolean,
): ChangeAction {
  const author = change.origin?.author.name ?? null;
  const touchesActive = activePath !== null && change.paths.includes(activePath);
  if (!touchesActive) return { type: 'refresh' };
  if (change.kind === 'removed') return { type: 'deleted', author, dirty };
  // 'created' (treated as 'modified') or 'modified' on the active path.
  return dirty ? { type: 'conflict', author } : { type: 'reload', author };
}

/** A structural tree operation that may need the clean-buffer gate. */
export type StructuralOp = 'create' | 'rename' | 'move' | 'delete';

/** A gated structural op (create is exempt — see {@link structuralOpGated}). */
export type GatedStructuralOp = Exclude<StructuralOp, 'create'>;

/**
 * Whether a structural op must gate on a clean active buffer (ticket 08 §5).
 * Create is exempt — it rewrites no existing file and cannot stale the active
 * buffer; rename/move/delete gate whenever the active buffer is dirty (they
 * rewrite links across the Bundle and can't run with unsaved changes open).
 */
export function structuralOpGated(op: StructuralOp, dirty: boolean): boolean {
  return dirty && op !== 'create';
}

// --- User-facing copy for the concurrency surfaces (ticket 08 §3-5) ---------
// Kept here (pure, unit-tested) so the `.svelte` glue never inlines message
// strings; each takes the attributed writer name or `null` (external/desktop
// edit) and returns the exact wording the modal / notice renders.

/** Blocking conflict-dialog heading (ticket 08 §3): who changed the Concept. */
export function conflictTitle(concept: string, author: string | null): string {
  return author
    ? `${concept} was changed by ${author}.`
    : `${concept} was changed on disk.`;
}

/** Non-blocking clean-reload notice (ticket 08 §3): "Updated by <author>". */
export function updatedNoticeText(author: string | null): string {
  return author ? `Updated by ${author}` : 'Updated on disk';
}

/** Deleted-state message (ticket 08 §2): the active Concept was removed. */
export function deletedStateText(author: string | null): string {
  return author ? `This Concept was deleted (by ${author}).` : 'This Concept was deleted.';
}

/** Three-way leave-prompt heading (ticket 08 §4): unsaved edits on exit. */
export function leavePromptText(concept: string): string {
  return `Save changes to ${concept}?`;
}

/**
 * Three-way structural-op prompt heading (ticket 08 §5): the active buffer
 * `active` is dirty and a rename/move/delete of `target` needs the clean-buffer
 * gate first.
 */
export function structuralPromptText(
  op: GatedStructuralOp,
  target: string,
  active: string,
): string {
  const verb = op === 'rename' ? 'renaming' : op === 'move' ? 'moving' : 'deleting';
  return `Save ${active} before ${verb} ${target}?`;
}
