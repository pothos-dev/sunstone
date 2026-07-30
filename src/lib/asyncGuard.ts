/**
 * Guards against a stale async result overwriting a newer one, for callers
 * that re-run the same async operation on every input change (e.g. a search
 * box re-querying on each keystroke) and only want the LATEST call's result.
 */
export function createLatestGuard(): { next(): number; isLatest(token: number): boolean } {
  let token = 0;
  return {
    next: () => ++token,
    isLatest: (t: number) => t === token,
  };
}

/**
 * Guards against an async result landing after its owning scope (e.g. an
 * `$effect`) has been cleaned up or superseded. Start one per scope, check
 * `isCancelled()` before applying the result, and call `cancel()` from the
 * scope's cleanup/teardown.
 */
export function createCancelGuard(): { isCancelled(): boolean; cancel(): void } {
  let cancelled = false;
  return {
    isCancelled: () => cancelled,
    cancel: () => {
      cancelled = true;
    },
  };
}
