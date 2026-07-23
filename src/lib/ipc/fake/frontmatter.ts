// Test-only frontmatter affordance for the in-memory fake backend.
//
// The index-parse kernels (`parseFrontmatter` / `parseFrontmatterFields` /
// `parseFrontmatterKeys`) migrated to the shared wasm source in family 11 (ADR
// 0006 §11-A) — the fake now consumes them via `$lib/wasm/exports`. What stays
// here is the line-based `stripTagsFromFrontmatter` (ADR 0006 §11-D), a fake
// stand-in with no Rust twin; its final disposition belongs with the rest of
// the fake stand-ins in family 12.

/**
 * Remove a `tags:` entry — an inline `[...]` value or a block list of `- item`
 * lines — from a Concept's content. Returns the rewritten content, or `null`
 * when there was no `tags:` entry (so the caller can skip a no-op write).
 *
 * Test-only: backs the fake backend's `clearAllTags` hook, which drives the
 * "Bundle has no tags" UI state. Line-based (not a YAML round-trip) on purpose —
 * it only needs to handle the fixtures' tag shapes.
 */
export function stripTagsFromFrontmatter(content: string): string | null {
  const lines = content.split('\n');
  const out: string[] = [];
  let stripping = false;
  let changed = false;
  for (const line of lines) {
    if (stripping) {
      // Drop block-list items belonging to the removed `tags:` key.
      if (/^\s*-\s+/.test(line)) {
        changed = true;
        continue;
      }
      stripping = false;
    }
    if (/^tags:\s*\[.*\]\s*$/.test(line)) {
      changed = true;
      continue;
    }
    if (/^tags:\s*$/.test(line)) {
      stripping = true;
      changed = true;
      continue;
    }
    out.push(line);
  }
  return changed ? out.join('\n') : null;
}
