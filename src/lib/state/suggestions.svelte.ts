import { backend } from '$lib/ipc';

/**
 * The Bundle's tag values, for the tag filter. Rune-backed; the app shell
 * calls `refresh()` from a single `$effect` keyed on `indexStore.version`, so a
 * file change on disk re-fetches them and a newly-introduced tag appears
 * immediately. (Frontmatter key/value completion lives in `okf/complete.ts`.)
 */
class SuggestionsStore {
  /** Distinct tag values across the Bundle (no OKF tag vocabulary exists). */
  tags = $state<string[]>([]);

  /**
   * Re-fetch the tags from the backend. Guarded so a backend that does not
   * serve the query (or a transient fetch failure) leaves the list untouched
   * rather than surfacing an unhandled promise rejection.
   */
  refresh(): void {
    // Concept paths are not copied here — quick-nav reads the single source,
    // `indexStore.conceptPaths()` (ADR 0006 family 10/16).
    void backend
      .allTags()
      .then((counts) => {
        this.tags = counts.map((c) => c.tag);
      })
      .catch(() => {});
  }
}

export const suggestions = new SuggestionsStore();
