<script lang="ts">
  // Settings › Keyboard: rebind a shortcut by clicking it and pressing the new
  // keys (Backspace unbinds, Escape cancels). Collisions are flagged, not
  // refused. Only changed shortcuts are written (`keybindings.<id>`).
  import { settings } from '$lib/state/settings.svelte';
  import {
    chordCaps,
    chordConflicts,
    chordFromEvent,
    COMMAND_GROUPS,
    COMMANDS,
    FIXED_SHORTCUTS,
    isMacPlatform,
    isRecordableChord,
    sameChord,
  } from '$lib/settings/keybindings';
  import { filterCommands } from '$lib/settings/settingsPage';
  import ResetButton from './ResetButton.svelte';

  interface Props {
    /** The command being recorded; bound so the dialog's Escape handling knows. */
    recording: string | null;
  }
  let { recording = $bindable() }: Props = $props();

  const mac = isMacPlatform();
  let query = $state('');
  /** Set when the last key pressed while recording can't be a shortcut. */
  let refused = $state(false);

  const shown = $derived(filterCommands(query, settings.keybindings, mac));

  function record(e: KeyboardEvent, id: string) {
    // Every key belongs to the recorder while it listens (Ctrl+K must not open Quick open).
    e.preventDefault();
    e.stopPropagation();
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    if (plain && e.key === 'Escape') {
      recording = null;
      return;
    }
    if (plain && (e.key === 'Backspace' || e.key === 'Delete')) {
      bind(id, null);
      return;
    }
    if (plain && e.key === 'Tab') return;
    const chord = chordFromEvent(e, mac);
    if (chord === null) return;
    if (!isRecordableChord(chord)) {
      refused = true;
      return;
    }
    bind(id, chord);
  }

  function bind(id: string, chord: string | null) {
    const def = COMMANDS.find((c) => c.id === id)?.default ?? null;
    if (sameChord(chord, def, mac)) settings.reset(['keybindings', id]);
    else settings.set(['keybindings', id], chord);
    recording = null;
  }
</script>

{#snippet caps(chord: string)}
  {#each chordCaps(chord, mac) as cap, i (i)}<kbd>{cap}</kbd>{/each}
{/snippet}

<input
  class="filter"
  type="search"
  placeholder="Filter by command or keys…"
  bind:value={query}
  aria-label="Filter shortcuts"
  data-testid="settings-keys-filter"
/>

{#each COMMAND_GROUPS as group (group)}
  {@const cmds = shown.filter((c) => c.group === group)}
  {#if cmds.length > 0}
    <h3 class="group">{group}</h3>
    <div class="table">
      {#each cmds as c (c.id)}
        {@const chord = settings.keybindings[c.id] ?? null}
        {@const clash = chord === null ? [] : chordConflicts(chord, c.id, settings.keybindings)}
        <div class="key-row" class:clash={clash.length > 0} data-testid="settings-key-{c.id}">
          <span class="key-label">
            {#if settings.isSet(['keybindings', c.id])}<span class="set-dot" title="Changed from the default"></span>{/if}{c.label}
            {#if c.scope === 'editor'}<span class="scope">editor</span>{/if}
          </span>
          <span class="key-chord">
            {#if recording === c.id}
              <button
                type="button"
                class="chord recording"
                aria-label="Press the new shortcut for {c.label}"
                onkeydown={(e) => record(e, c.id)}
                onblur={() => (recording = null)}
                {@attach (el) => el.focus()}
                >{#if refused}Add {mac ? 'Cmd, Ctrl' : 'Ctrl'} or {mac ? 'Option' : 'Alt'}…{:else}Press keys…{/if}
                <small>Esc cancels · ⌫ clears</small></button
              >
            {:else}
              <button
                type="button"
                class="chord"
                title="Change"
                aria-label="Change the shortcut for {c.label}"
                onclick={() => {
                  refused = false;
                  recording = c.id;
                }}
              >
                {#if chord === null}<span class="unbound">Not set</span>{:else}{@render caps(chord)}{/if}
              </button>
            {/if}
            <ResetButton
              shown={settings.isSet(['keybindings', c.id])}
              label="{c.label} shortcut"
              onreset={() => settings.reset(['keybindings', c.id])}
            />
          </span>
          {#if clash.length > 0}
            <span class="clash-note">Also bound to {clash.join(', ')}.</span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
{/each}

{#if shown.length === 0}
  <p class="intro">No shortcut matches “{query}”.</p>
{/if}

<h3 class="group">Fixed</h3>
<div class="table">
  {#each FIXED_SHORTCUTS.filter((f, i, all) => all.findIndex((g) => g.label === f.label) === i) as f (f.label)}
    <div class="key-row fixed">
      <span class="key-label">{f.label}</span>
      <span class="key-chord"
        ><span class="chord static">{@render caps(f.chord)}{#if f.label === 'Move focus'}<span class="more">+ arrows</span>{/if}</span
        ><span class="reset-slot"></span></span
      >
    </div>
  {/each}
</div>

<style>
  .filter {
    box-sizing: border-box;
    width: 100%;
    margin: 0.9rem 0 0.3rem;
    padding: 0.45rem 0.65rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    font: inherit;
  }
  .filter:focus {
    outline: 2px solid var(--accent-ring);
    outline-offset: -1px;
  }
  .group {
    margin: 1.1rem 0 0.3rem;
    color: var(--text-muted);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .table {
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .key-row {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    padding: 0.3rem 0.4rem 0.3rem 0.8rem;
    border-bottom: 1px solid var(--border);
  }
  .key-row:last-child {
    border-bottom: 0;
  }
  .key-row:hover {
    background: var(--hover);
  }
  .key-row.clash {
    background: color-mix(in srgb, var(--danger) 7%, transparent);
  }
  .key-row.fixed {
    color: var(--text-muted);
  }
  .key-label {
    display: flex;
    align-items: center;
    font-size: 0.9rem;
  }
  .scope {
    margin-left: 0.5rem;
    padding: 0 0.4rem;
    border-radius: var(--radius-pill);
    background: var(--bg-sunken);
    color: var(--text-muted);
    font-size: 0.7rem;
  }
  .key-chord {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .chord {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.2rem;
    min-width: 7rem;
    padding: 0.2rem 0.35rem;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
    font: inherit;
  }
  button.chord {
    cursor: pointer;
  }
  button.chord:hover {
    border-color: var(--border-strong);
  }
  button.chord:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: -1px;
  }
  .chord.recording {
    justify-content: center;
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--text);
    font-size: 0.8rem;
    outline: none;
  }
  .chord.recording small {
    color: var(--text-muted);
  }
  .unbound,
  .more {
    color: var(--text-faint);
    font-size: 0.8rem;
  }
  .more {
    margin-left: 0.2rem;
  }
  .reset-slot {
    width: 1.6rem;
  }
  .clash-note {
    grid-column: 1 / -1;
    padding: 0.1rem 0 0.2rem;
    color: var(--danger);
    font-size: 0.8rem;
  }
</style>
