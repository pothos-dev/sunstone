<script lang="ts">
  // PROTOTYPE — floating variant switcher (← label →; arrow keys cycle when no
  // text field is focused). Dev builds only. Throwaway.
  interface Props {
    variants: { key: string; name: string }[];
    current: string;
  }
  let { variants, current = $bindable() }: Props = $props();

  const index = $derived(Math.max(0, variants.findIndex((v) => v.key === current)));

  function step(d: number) {
    current = variants[(index + d + variants.length) % variants.length].key;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea, select, [contenteditable], [role="listbox"], [data-own-arrows]')) return;
    e.preventDefault();
    step(e.key === 'ArrowLeft' ? -1 : 1);
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="proto-switcher" role="toolbar" aria-label="Prototype variant">
  <button type="button" onclick={() => step(-1)} aria-label="Previous variant">←</button>
  <span><b>{variants[index].key}</b> — {variants[index].name}</span>
  <button type="button" onclick={() => step(1)} aria-label="Next variant">→</button>
</div>

<style>
  .proto-switcher {
    position: fixed;
    left: 50%;
    bottom: 14px;
    transform: translateX(-50%);
    z-index: 3000;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-radius: 999px;
    background: #111;
    color: #fff;
    font: 13px/1.2 system-ui, sans-serif;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  }
  button {
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: 999px;
    background: #333;
    color: #fff;
    cursor: pointer;
  }
  button:hover {
    background: #555;
  }
  span {
    min-width: 13rem;
    text-align: center;
  }
</style>
