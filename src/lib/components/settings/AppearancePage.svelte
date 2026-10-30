<script lang="ts">
  // Settings › Appearance: light/dark mode and the current colour theme (whose
  // picker is a subpage, `ColorThemePage`).
  import { settings } from '$lib/state/settings.svelte';
  import { DEFAULT_PRESET_ID, presetById } from '$lib/state/themePresets';
  import { THEME_MODES } from '$lib/settings/settingsPage';
  import ResetButton from './ResetButton.svelte';
  import ThemeThumb from './ThemeThumb.svelte';

  interface Props {
    onbrowse: () => void;
  }
  let { onbrowse }: Props = $props();

  const preset = $derived(presetById(settings.get(['colorTheme']) ?? DEFAULT_PRESET_ID));
</script>

<div class="row">
  <div class="label">
    <div class="name">
      {#if settings.isSet(['theme'])}<span class="set-dot" title="Changed from the default"></span>{/if}Mode
    </div>
    <div class="hint">Follow the system, or always use light or dark.</div>
  </div>
  <div class="control">
    <div class="segmented" role="radiogroup" aria-label="Mode">
      {#each THEME_MODES as m (m.id)}
        <button
          type="button"
          role="radio"
          aria-checked={settings.themeMode === m.id}
          class:on={settings.themeMode === m.id}
          onclick={() => (m.id === 'system' ? settings.reset(['theme']) : settings.set(['theme'], m.id))}
          >{m.label}</button
        >
      {/each}
    </div>
    <ResetButton shown={settings.isSet(['theme'])} label="mode" onreset={() => settings.reset(['theme'])} />
  </div>
</div>

<div class="row">
  <div class="label">
    <div class="name">
      {#if settings.isSet(['colorTheme']) || settings.isSet(['colors'])}<span class="set-dot" title="Changed from the default"></span>{/if}Colour theme
    </div>
    <div class="hint">One palette for light and dark. Single colours can be changed on top of it.</div>
  </div>
  <div class="control">
    <button type="button" class="current" data-testid="settings-browse-themes" onclick={onbrowse}>
      <span class="thumb"><ThemeThumb light={preset.light} dark={preset.dark} /></span>
      <span class="current-name">
        {preset.name}
        {#if settings.isSet(['colors'])}<small>with your own colours</small>{/if}
      </span>
      <span class="browse">Change ›</span>
    </button>
  </div>
</div>

<style>
  .current {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.4rem 0.7rem 0.4rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .current:hover {
    border-color: var(--border-strong);
  }
  .current:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: 1px;
  }
  .thumb {
    width: 5.5rem;
  }
  .current-name {
    display: flex;
    flex-direction: column;
    font-weight: 500;
    text-align: left;
  }
  .current-name small {
    font-weight: 400;
    color: var(--text-muted);
  }
  .browse {
    color: var(--accent);
    font-size: 0.85rem;
    white-space: nowrap;
  }
</style>
