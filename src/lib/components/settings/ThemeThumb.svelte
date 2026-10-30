<script lang="ts">
  // A colour theme as a tiny app window (sidebar + page), light and dark side
  // by side. Used by the Appearance page's current-theme card and the picker.
  import type { Palette } from '$lib/state/themePresets';

  interface Props {
    light: Palette;
    dark: Palette;
  }
  let { light, dark }: Props = $props();
</script>

{#snippet window(pal: Palette)}
  <span
    class="win"
    style="--t-bg:{pal.bg}; --t-sunken:{pal.bgSunken}; --t-text:{pal.text}; --t-muted:{pal.textMuted}; --t-border:{pal.border}; --t-accent:{pal.accent};"
  >
    <span class="side"><i></i><i></i><i class="on"></i><i></i></span>
    <span class="page"><b></b><i></i><i></i><i class="short"></i><u></u></span>
  </span>
{/snippet}

<span class="thumb" aria-hidden="true">{@render window(light)}{@render window(dark)}</span>

<style>
  .thumb {
    display: grid;
    grid-template-columns: 1fr 1fr;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .win {
    display: grid;
    grid-template-columns: 28% 1fr;
    aspect-ratio: 4 / 3;
    background: var(--t-bg);
  }
  .side,
  .page {
    display: flex;
    flex-direction: column;
  }
  .side {
    gap: 9%;
    padding: 18% 14%;
    background: var(--t-sunken);
    border-right: 1px solid var(--t-border);
  }
  .page {
    gap: 7%;
    padding: 14% 12%;
  }
  i,
  b,
  u {
    display: block;
    border-radius: 2px;
  }
  i {
    height: 3px;
    background: var(--t-muted);
    opacity: 0.6;
  }
  i.on {
    background: var(--t-accent);
    opacity: 1;
  }
  i.short {
    width: 55%;
  }
  b {
    width: 60%;
    height: 5px;
    background: var(--t-text);
  }
  u {
    width: 38%;
    height: 7px;
    margin-top: auto;
    background: var(--t-accent);
  }
</style>
