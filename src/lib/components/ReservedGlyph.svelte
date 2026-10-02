<script lang="ts">
  // Outline icon for a Reserved file affordance (`index.md` / `log.md`), drawn
  // in `currentColor` so it follows the button's text colour and theme.
  import type { ReservedKind } from '$lib/reserved';

  let { kind }: { kind: ReservedKind } = $props();
</script>

<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
  {#if kind === 'log'}
    <!-- clock: the change log -->
    <circle cx="8" cy="8" r="5.75" fill="none" stroke="currentColor" stroke-width="1.3" />
    <polyline
      points="8,4.75 8,8 10.25,9.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  {:else}
    <!-- page with lines: the index -->
    <rect x="3" y="2" width="10" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3" />
    <line x1="5.5" y1="6" x2="10.5" y2="6" stroke="currentColor" stroke-width="1.2" />
    <line x1="5.5" y1="8.5" x2="10.5" y2="8.5" stroke="currentColor" stroke-width="1.2" />
    <line x1="5.5" y1="11" x2="8.5" y2="11" stroke="currentColor" stroke-width="1.2" />
  {/if}
</svg>
