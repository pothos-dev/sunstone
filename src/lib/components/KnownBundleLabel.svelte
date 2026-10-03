<script lang="ts">
  // The label of one known-folder row, shared by the startup launcher and the
  // in-editor Bundle switcher: the root index.md title (when there is one) over
  // the path, which then drops to a smaller, muted second line. Fuzzy-match hits
  // from `launcherRows` are highlighted in both.
  import { highlightPositions } from '$lib/highlight';
  import type { LauncherRow } from '$lib/launcherRows';

  let { row }: { row: LauncherRow } = $props();
</script>

<span class="label" class:missing={!row.bundle.exists}>
  {#if row.bundle.title}
    <span class="title" data-testid="launcher-title"
      >{#each highlightPositions(row.bundle.title, row.titlePositions) as seg}<span
          class:hit={seg.match}>{seg.text}</span
        >{/each}</span
    >
  {/if}
  <span class="path" class:sub={!!row.bundle.title}
    >{#each highlightPositions(row.bundle.path, row.positions) as seg}<span class:hit={seg.match}
        >{seg.text}</span
      >{/each}</span
  >
</span>

<style>
  .label {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .title,
  .path {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 0.9rem;
  }

  /* Under a title, the path is the secondary line. */
  .path.sub {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .hit {
    color: var(--accent);
    font-weight: 700;
  }

  .missing .title,
  .missing .path {
    color: var(--text-muted);
  }
</style>
