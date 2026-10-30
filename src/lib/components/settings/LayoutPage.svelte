<script lang="ts">
  // Settings › Layout: how a Bundle opens the first time (`defaults` in
  // config.json). Setting a toggle back to the built-in removes its key.
  import { settings } from '$lib/state/settings.svelte';
  import { BUILTIN_PANEL_DEFAULTS, PANEL_TOGGLES, type PanelToggle } from '$lib/settings/panelDefaults';
  import ResetButton from './ResetButton.svelte';

  const MODES = [
    { id: 'read', label: 'Read' },
    { id: 'editing', label: 'Editing' },
  ] as const;

  function setToggle(key: PanelToggle, on: boolean) {
    if (on === BUILTIN_PANEL_DEFAULTS[key]) settings.reset(['defaults', key]);
    else settings.set(['defaults', key], on);
  }

  function setMode(id: 'read' | 'editing') {
    if (id === BUILTIN_PANEL_DEFAULTS.editorMode) settings.reset(['defaults', 'editorMode']);
    else settings.set(['defaults', 'editorMode'], id);
  }
</script>

<p class="intro">
  How a Bundle opens the first time. A Bundle you have opened before keeps the layout you left it in.
</p>

<div class="row">
  <div class="label">
    <div class="name">
      {#if settings.isSet(['defaults', 'editorMode'])}<span class="set-dot" title="Changed from the default"></span>{/if}Open Concepts in
    </div>
    <div class="hint">Read shows the rendered page; Editing lets you type straight away.</div>
  </div>
  <div class="control">
    <div class="segmented" role="radiogroup" aria-label="Open Concepts in">
      {#each MODES as m (m.id)}
        <button
          type="button"
          role="radio"
          aria-checked={settings.panelDefaults.editorMode === m.id}
          class:on={settings.panelDefaults.editorMode === m.id}
          onclick={() => setMode(m.id)}>{m.label}</button
        >
      {/each}
    </div>
    <ResetButton
      shown={settings.isSet(['defaults', 'editorMode'])}
      label="editor mode"
      onreset={() => settings.reset(['defaults', 'editorMode'])}
    />
  </div>
</div>

<div class="toggles">
  {#each PANEL_TOGGLES as t (t.key)}
    <label class="toggle">
      <span class="name">{#if settings.isSet(['defaults', t.key])}<span class="set-dot" title="Changed from the default"></span>{/if}{t.label}</span>
      <input
        type="checkbox"
        class="switch"
        checked={settings.panelDefaults[t.key]}
        onchange={(e) => setToggle(t.key, e.currentTarget.checked)}
        data-testid="settings-default-{t.key}"
      />
    </label>
  {/each}
</div>

<style>
  .toggles {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0 1.5rem;
    padding-top: 0.4rem;
  }
  .toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.65rem 0;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
  }
  .toggle .name {
    font-weight: 400;
  }
</style>
