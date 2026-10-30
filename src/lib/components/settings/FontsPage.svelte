<script lang="ts">
  // Settings › Fonts: family and size per role. Writes only `family` and
  // `size`; font `files` listed by hand in config.json are left alone.
  import { settings } from '$lib/state/settings.svelte';
  import type { FontRoleName } from '$lib/state/fonts';
  import { clampFontSize, FONT_ROLE_META, FONT_SUGGESTIONS } from '$lib/settings/settingsPage';
  import ResetButton from './ResetButton.svelte';

  const ROLES = Object.keys(FONT_ROLE_META) as FontRoleName[];
  const listId = 'settings-font-suggestions';

  function family(role: FontRoleName): string {
    const v = settings.get(['fonts', role, 'family']);
    return typeof v === 'string' ? v : '';
  }

  function size(role: FontRoleName): number | null {
    const v = settings.get(['fonts', role, 'size']);
    return typeof v === 'number' ? v : null;
  }

  function setFamily(role: FontRoleName, value: string) {
    const v = value.trim();
    if (v === '') settings.reset(['fonts', role, 'family']);
    else settings.set(['fonts', role, 'family'], v);
  }

  function setSize(role: FontRoleName, n: number) {
    const meta = FONT_ROLE_META[role].size;
    if (!meta) return;
    const v = clampFontSize(meta, n);
    if (v !== null) settings.set(['fonts', role, 'size'], v);
  }

  function resetRole(role: FontRoleName) {
    settings.reset(['fonts', role, 'family']);
    settings.reset(['fonts', role, 'size']);
  }

  /** The role's live CSS variable, so the sample shows exactly what the app uses. */
  const FAMILY_VAR: Record<FontRoleName, string> = {
    ui: 'var(--font-ui)',
    content: 'var(--font-content)',
    heading: 'var(--font-heading)',
    code: 'var(--font-mono)',
  };
</script>

<datalist id={listId}>
  {#each FONT_SUGGESTIONS as f (f)}<option value={f}></option>{/each}
</datalist>

{#each ROLES as role (role)}
  {@const meta = FONT_ROLE_META[role]}
  {@const touched = settings.isSet(['fonts', role, 'family']) || settings.isSet(['fonts', role, 'size'])}
  <div class="font">
    <div class="row flat">
      <div class="label">
        <div class="name">{#if touched}<span class="set-dot" title="Changed from the default"></span>{/if}{meta.label}</div>
        <div class="hint">{meta.hint}</div>
      </div>
      <div class="control">
        <input
          class="family"
          type="text"
          list={listId}
          spellcheck="false"
          placeholder={meta.placeholder}
          value={family(role)}
          onchange={(e) => setFamily(role, e.currentTarget.value)}
          aria-label="{meta.label} font family"
          data-testid="settings-font-{role}-family"
        />
        {#if meta.size}
          {@const s = meta.size}
          <span class="size">
            <button type="button" aria-label="Smaller {meta.label} text" onclick={() => setSize(role, (size(role) ?? s.def) - s.step)}
              >−</button
            >
            <input
              type="number"
              min={s.min}
              max={s.max}
              step={s.step}
              placeholder={String(s.def)}
              value={size(role) ?? ''}
              onchange={(e) =>
                e.currentTarget.value === ''
                  ? settings.reset(['fonts', role, 'size'])
                  : setSize(role, Number.parseFloat(e.currentTarget.value))}
              aria-label="{meta.label} font size"
              data-testid="settings-font-{role}-size"
            />
            <span class="unit">{s.unit}</span>
            <button type="button" aria-label="Larger {meta.label} text" onclick={() => setSize(role, (size(role) ?? s.def) + s.step)}
              >+</button
            >
          </span>
        {:else}
          <span class="no-size">size per level</span>
        {/if}
        <ResetButton shown={touched} label="{meta.label} font" onreset={() => resetRole(role)} />
      </div>
    </div>
    <div
      class="sample"
      class:heading={role === 'heading'}
      style:font-family={FAMILY_VAR[role]}
      style:font-size={role === 'ui' ? 'var(--font-ui-size)' : role === 'content' ? 'var(--font-content-size)' : role === 'code' ? 'calc(var(--font-code-scale, 1) * var(--font-content-size))' : undefined}
    >
      {meta.sample}
    </div>
    {#if settings.isSet(['fonts', role, 'files'])}
      <div class="files">This font's files come from config.json and are kept as they are.</div>
    {/if}
  </div>
{/each}

<style>
  .font {
    padding: 0.95rem 0;
    border-bottom: 1px solid var(--border);
  }
  .family {
    width: 12rem;
    padding: 0.35rem 0.55rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 0.875rem;
  }
  .size {
    display: inline-flex;
    align-items: center;
    overflow: hidden;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg);
  }
  .size button {
    width: 1.7rem;
    height: 1.9rem;
    border: 0;
    background: none;
    color: var(--text-muted);
    font: inherit;
    cursor: pointer;
  }
  .size button:hover {
    background: var(--hover);
    color: var(--text);
  }
  .size input {
    width: 3rem;
    border: 0;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 0.875rem;
    text-align: right;
    appearance: textfield;
  }
  .size input::-webkit-inner-spin-button {
    -webkit-appearance: none;
  }
  .family:focus,
  .size input:focus {
    outline: 2px solid var(--accent-ring);
    outline-offset: -1px;
  }
  .unit {
    padding: 0 0.2rem 0 0.15rem;
    color: var(--text-muted);
    font-size: 0.8rem;
  }
  .no-size {
    width: 7.75rem;
    color: var(--text-faint);
    font-size: 0.8rem;
    text-align: center;
  }
  .sample {
    margin-top: 0.6rem;
    padding: 0.6rem 0.8rem;
    overflow: hidden;
    border: 1px dashed var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .sample.heading {
    font-size: 1.35em;
    font-weight: 600;
  }
  .files {
    margin-top: 0.35rem;
    color: var(--text-muted);
    font-size: 0.8rem;
  }
</style>
