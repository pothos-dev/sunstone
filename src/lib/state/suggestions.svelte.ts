import { backend } from '$lib/ipc';

/**
 * OKF recommended frontmatter keys (okf-spec §4.1). Always offered for key
 * autocomplete (even on an empty Bundle) and merged with the keys actually used
 * across the Bundle.
 */
const OKF_KEYS = ['type', 'title', 'description', 'resource', 'tags', 'timestamp'];

/**
 * Index-derived autocomplete sources for the Properties panel (`type`/key/tag
 * fields) and the quick-nav palette (Concept paths). Rune-backed; the app shell
 * calls `refresh()` from a single `$effect` keyed on `indexStore.version`, so a
 * file change on disk re-fetches all of these together and newly-introduced
 * paths/types/keys/tags appear in suggestions immediately.
 */
class SuggestionsStore {
  /** Existing `type` values across the Bundle. */
  types = $state<string[]>([]);
  /** OKF recommended keys ∪ distinct keys used across the Bundle (deduped). */
  keys = $state<string[]>([]);
  /** Distinct tag values across the Bundle (no OKF tag vocabulary exists). */
  tags = $state<string[]>([]);

  /**
   * Re-fetch every index-derived suggestion list from the backend. Each call is
   * guarded so a backend that does not serve a given query (or a transient
   * fetch failure) leaves that list untouched rather than surfacing an
   * unhandled promise rejection — the OKF recommended keys still seed key
   * autocomplete even when the bundle-sourced keys fail to load.
   */
  refresh(): void {
    // Concept paths are no longer copied here — quick-nav reads the single
    // source, `indexStore.conceptPaths()` (ADR 0006 family 10/16). This store
    // now only serves the index-derived type/key/tag suggestion lists.
    void backend
      .allTypes()
      .then((t) => {
        this.types = t;
      })
      .catch(() => {});
    void backend
      .allKeys()
      .then((k) => {
        this.keys = [...new Set([...OKF_KEYS, ...k])];
      })
      .catch(() => {});
    void backend
      .allTags()
      .then((counts) => {
        this.tags = counts.map((c) => c.tag);
      })
      .catch(() => {});
  }
}

export const suggestions = new SuggestionsStore();
