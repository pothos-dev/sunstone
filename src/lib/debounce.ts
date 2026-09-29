// Trailing-edge debounce timer (pure; no DOM/IPC).
//
// Owns ONLY the cancel-and-reschedule timer mechanics shared by the autosave
// (editor) and session-persistence stores. Callers keep their own "should I
// actually run / flush" logic — this just collapses rapid `schedule()` calls
// into a single deferred `action()` run.

export interface Debouncer {
  /** (Re)start the timer; `action` runs once `ms` elapse with no new schedule. */
  schedule(): void;
  /** Cancel a pending run, if any, without running it. */
  cancel(): void;
  /**
   * Run a pending action NOW (cancelling its timer) instead of waiting out the
   * quiet period — for teardown, e.g. the app closing. Returns whether anything
   * was pending; a no-op when idle.
   */
  flush(): boolean;
  /** True while a run is scheduled and has not yet fired. */
  readonly pending: boolean;
}

/** Create a debouncer that runs `action` `ms` after the last `schedule()`. */
export function createDebouncer(action: () => void, ms: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  function cancel(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }
  return {
    schedule(): void {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        action();
      }, ms);
    },
    cancel,
    flush(): boolean {
      if (timer === null) return false;
      cancel();
      action();
      return true;
    },
    get pending(): boolean {
      return timer !== null;
    },
  };
}
