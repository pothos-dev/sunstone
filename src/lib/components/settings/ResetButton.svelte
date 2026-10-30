<script lang="ts">
  // "Back to the default" for one setting: removes its key(s) from config.json.
  // Shown only while the setting is set; otherwise it keeps its slot so the
  // controls in a column stay aligned.
  interface Props {
    shown: boolean;
    label: string;
    onreset: () => void;
  }
  let { shown, label, onreset }: Props = $props();
</script>

{#if shown}
  <button type="button" class="reset" title="Reset to default" aria-label="Reset {label} to default" onclick={onreset}>
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M3.2 8a4.8 4.8 0 1 0 1.4-3.4M3 2.5v2.6h2.6"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </button>
{:else}
  <span class="reset" aria-hidden="true"></span>
{/if}

<style>
  .reset {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 1.6rem;
    height: 1.6rem;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-muted);
  }
  button.reset {
    cursor: pointer;
  }
  button.reset:hover {
    background: var(--hover);
    color: var(--accent);
  }
  button.reset:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: -2px;
  }
</style>
