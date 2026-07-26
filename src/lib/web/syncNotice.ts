/**
 * User-facing copy for the git sync loop's divergence notices (git-sync spec
 * §10.2 / §10.4).
 *
 * Pure plain `.ts` (the repo's "pure logic lives in `.ts`" convention) so the
 * exact wording is unit-tested under `bun test src/lib` and the `.svelte` notice
 * slot never inlines a message string.
 *
 * Two rules the wording obeys, both load-bearing:
 *   - **Impersonal.** The notice is broadcast to EVERY connected client, not to
 *     the author of the diverging action (the payload carries no author at all),
 *     so it can never say "your edit".
 *   - **The path is content, not a link.** The whole payload of a `forked` notice
 *     is a filename to remember; naming it is enough to reach it via Ctrl+K, and
 *     linking it is the first step of a reconciliation UX that is out of scope.
 */

import type { SyncNotice } from '$lib/types';

/**
 * The single line rendered in the dismissible sync-notice slot for `notice`.
 * Both kinds share one affordance, so this is the only branch on `kind`.
 */
export function syncNoticeText(notice: SyncNotice): string {
  if (notice.kind === 'forked') {
    return `A conflicting copy of ${notice.path} was saved as ${notice.fork}`;
  }
  return `Deletion of ${notice.path} was reverted — it was modified on origin.`;
}
