<script lang="ts">
  // Read-only frontmatter: a metadata grid (key → value), one row per top-level
  // entry, a sequence (e.g. `tags`) as a list. Shared by the web reader and the
  // desktop Tile's read mode; editing mode swaps in the YAML editor instead
  // (`Frontmatter.svelte`). The fields come from the Rust `frontmatter_fields`
  // (server-side on the web, `parseFrontmatterFields` over wasm on desktop).
  import type { FrontmatterField } from '$lib/types';

  let { fields }: { fields: FrontmatterField[] } = $props();
</script>

<dl class="properties" data-testid="properties">
  {#each fields as field (field.key)}
    <dt>{field.key}</dt>
    <!-- One line: `pre-wrap` below would otherwise render the markup's indentation. -->
    <dd>{#if field.values.length > 1}<ul class="prop-list">{#each field.values as v, i (i)}<li>{v}</li>{/each}</ul>{:else}{field.values[0] ?? ''}{/if}</dd>
  {/each}
</dl>

<style>
  .properties {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.15rem 0.75rem;
    margin: 0 0 1.25rem;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--border, #e2e2e2);
    border-radius: var(--radius-sm, 6px);
    background: var(--bg-elevated, rgba(127, 127, 127, 0.06));
    font-size: 0.82rem;
  }

  .properties dt {
    font-weight: 600;
    color: var(--text-muted, #666);
  }

  /* Keep the line breaks of a block scalar or a nested map's YAML. */
  .properties dd {
    margin: 0;
    white-space: pre-wrap;
  }

  .prop-list {
    margin: 0;
    padding-left: 1rem;
  }
</style>
