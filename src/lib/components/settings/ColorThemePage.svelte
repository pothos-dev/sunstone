<script lang="ts">
  // Settings › Appearance › Colour theme: the preset picker, and under it the
  // twelve base colours per scheme to change one by one on top of the preset.
  import { settings } from '$lib/state/settings.svelte';
  import { BASE_COLORS, parseThemeColors, type BaseColor } from '$lib/state/themeColors';
  import { DEFAULT_PRESET_ID, presetById, THEME_PRESETS, withPreset } from '$lib/state/themePresets';
  import { COLOR_LABELS } from '$lib/settings/settingsPage';
  import ResetButton from './ResetButton.svelte';
  import ThemeThumb from './ThemeThumb.svelte';

  const COLOR_KEYS = Object.keys(BASE_COLORS) as BaseColor[];
  const HEX = /^#[0-9a-f]{6}$/i;

  let scheme = $state<'light' | 'dark'>('light');
  // Open straight away when the user already has colours of their own.
  let customOpen = $state(settings.isSet(['colors']));

  const presetId = $derived(presetById(settings.get(['colorTheme'])).id);
  const isColor = (v: string) => CSS.supports('color', v);
  /** What each colour is right now: the preset's, or the user's own. */
  const palette = $derived({
    ...presetById(presetId)[scheme],
    ...withPreset(presetId, parseThemeColors(settings.get(['colors']), isColor))[scheme],
  });

  function pick(id: string) {
    if (id === DEFAULT_PRESET_ID) settings.reset(['colorTheme']);
    else settings.set(['colorTheme'], id);
  }

  function setColor(key: BaseColor, value: string) {
    const v = value.trim();
    if (v !== '' && isColor(v)) settings.set(['colors', scheme, key], v);
  }
</script>

<div class="grid" role="radiogroup" aria-label="Colour theme">
  {#each THEME_PRESETS as t (t.id)}
    <button
      type="button"
      class="preset"
      class:on={presetId === t.id}
      role="radio"
      aria-checked={presetId === t.id}
      data-testid="settings-preset-{t.id}"
      onclick={() => pick(t.id)}
    >
      <ThemeThumb light={t.light} dark={t.dark} />
      <span class="preset-name">
        {t.name}
        {#if presetId === t.id}<span class="check" aria-hidden="true">✓</span>{/if}
      </span>
    </button>
  {/each}
</div>

<div class="custom">
  <button type="button" class="custom-head" aria-expanded={customOpen} onclick={() => (customOpen = !customOpen)}>
    <span class="chev" class:open={customOpen} aria-hidden="true">›</span>
    {#if settings.isSet(['colors'])}<span class="set-dot" title="Changed from the theme"></span>{/if}Your own colours
    <span class="custom-hint">Change single colours on top of {presetById(presetId).name}</span>
  </button>
  {#if customOpen}
    <div class="tabs" role="tablist" aria-label="Scheme">
      {#each ['light', 'dark'] as const as s (s)}
        <button type="button" role="tab" aria-selected={scheme === s} class:on={scheme === s} onclick={() => (scheme = s)}>
          {#if settings.isSet(['colors', s])}<span class="set-dot"></span>{/if}{s === 'light' ? 'Light' : 'Dark'}
        </button>
      {/each}
    </div>
    <div class="colors">
      {#each COLOR_KEYS as key (key)}
        <div class="color">
          <label class="swatch" style:background={palette[key]}>
            <input
              type="color"
              value={HEX.test(palette[key]) ? palette[key] : '#000000'}
              oninput={(e) => setColor(key, e.currentTarget.value)}
              aria-label="{COLOR_LABELS[key]} ({scheme})"
            />
          </label>
          <span class="color-name">
            {#if settings.isSet(['colors', scheme, key])}<span class="set-dot"></span>{/if}{COLOR_LABELS[key]}
          </span>
          <input
            class="value"
            type="text"
            spellcheck="false"
            value={palette[key]}
            onchange={(e) => setColor(key, e.currentTarget.value)}
            aria-label="{COLOR_LABELS[key]} ({scheme}) value"
          />
          <ResetButton
            shown={settings.isSet(['colors', scheme, key])}
            label={COLOR_LABELS[key]}
            onreset={() => settings.reset(['colors', scheme, key])}
          />
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(10.5rem, 1fr));
    gap: 0.8rem;
    padding: 1rem 0;
  }
  .preset {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.45rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .preset:hover {
    border-color: var(--border-strong);
  }
  .preset:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: 1px;
  }
  .preset.on {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .preset-name {
    display: flex;
    justify-content: space-between;
    padding: 0 0.2rem 0.1rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  .check {
    color: var(--accent);
  }
  .custom {
    padding-top: 0.6rem;
    border-top: 1px solid var(--border);
  }
  .custom-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    padding: 0.5rem 0;
    border: 0;
    background: none;
    color: var(--text);
    font: inherit;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
  }
  .chev {
    display: inline-block;
    width: 0.8rem;
    color: var(--text-muted);
    transition: transform 120ms;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .custom-hint {
    margin-left: auto;
    color: var(--text-muted);
    font-size: 0.85rem;
    font-weight: 400;
  }
  .tabs {
    display: flex;
    gap: 0.2rem;
    margin: 0.4rem 0 0.6rem;
    border-bottom: 1px solid var(--border);
  }
  .tabs button {
    display: flex;
    align-items: center;
    padding: 0.4rem 0.9rem;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--text-muted);
    font: inherit;
    cursor: pointer;
  }
  .tabs button.on {
    border-bottom-color: var(--accent);
    color: var(--text);
  }
  .colors {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.15rem 1.5rem;
  }
  .color {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.3rem 0;
  }
  .swatch {
    position: relative;
    flex: none;
    width: 1.6rem;
    height: 1.6rem;
    border: 1px solid var(--border-strong);
    border-radius: 50%;
    cursor: pointer;
  }
  .swatch:focus-within {
    outline: 2px solid var(--accent-ring);
    outline-offset: 1px;
  }
  .swatch input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
  .color-name {
    flex: 1;
    display: flex;
    align-items: center;
    font-size: 0.875rem;
  }
  .value {
    width: 6.5rem;
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--text);
    font: 0.8rem var(--font-mono);
  }
  .value:focus {
    outline: 2px solid var(--accent-ring);
    outline-offset: -1px;
  }
</style>
