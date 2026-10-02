<script lang="ts">
  // PROTOTYPE — throwaway. Floating bottom bar that cycles a `?variant=` search
  // param between UI prototype variants (←/→ buttons or arrow keys). Dev builds
  // only, so a stray merge can never ship it.
  import { onMount } from 'svelte';

  interface Props {
    variants: { key: string; name: string }[];
    current: string;
    onchange: (key: string) => void;
  }

  let { variants, current, onchange }: Props = $props();

  const index = $derived(Math.max(0, variants.findIndex((v) => v.key === current)));

  function step(by: number) {
    const next = variants[(index + by + variants.length) % variants.length];
    const url = new URL(location.href);
    url.searchParams.set('variant', next.key);
    history.replaceState(history.state, '', url);
    onchange(next.key);
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, [contenteditable="true"]')) return;
      if (!e.altKey || e.ctrlKey || e.metaKey) return; // Alt+←/→: plain arrows drive the app
      if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

{#if import.meta.env.DEV}
  <div class="proto-bar" data-testid="prototype-switcher">
    <button type="button" onclick={() => step(-1)} aria-label="Previous variant">←</button>
    <span>{variants[index].key} — {variants[index].name}</span>
    <button type="button" onclick={() => step(1)} aria-label="Next variant">→</button>
  </div>
{/if}

<style>
  .proto-bar {
    position: fixed;
    bottom: 1rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 10000;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.35rem 0.5rem;
    border-radius: 999px;
    background: #111;
    color: #fff;
    font: 600 0.8rem system-ui, sans-serif;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  }

  .proto-bar button {
    width: 1.8rem;
    height: 1.8rem;
    border: none;
    border-radius: 999px;
    background: #333;
    color: #fff;
    cursor: pointer;
  }

  .proto-bar button:hover {
    background: #555;
  }
</style>
