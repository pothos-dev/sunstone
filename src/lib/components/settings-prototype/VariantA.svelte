<script lang="ts">
  // PROTOTYPE — Variant A: a centred dialog with a sidebar of categories
  // (Obsidian / VS Code style). Colour themes live on a subpage. Throwaway.
  import { draft } from './draft.svelte';
  import {
    chordCaps,
    chordFromEvent,
    COLOR_KEYS,
    COLOR_LABELS,
    COMMAND_GROUPS,
    COMMANDS,
    conflicts,
    DEFAULT_PRESET,
    EDITOR_MODES,
    effectivePalette,
    FONT_ROLE_LABELS,
    FONT_ROLES,
    FONT_SUGGESTIONS,
    PANEL_DEFAULTS,
    presetById,
    PRESETS,
    THEME_MODES,
    type FontRole,
    type Palette,
  } from './model';

  interface Props {
    onclose: () => void;
  }
  let { onclose }: Props = $props();

  type Page = 'appearance' | 'fonts' | 'layout' | 'keyboard';
  const PAGES: { id: Page; label: string; icon: string }[] = [
    { id: 'appearance', label: 'Appearance', icon: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Zm0 1.5v9a4.5 4.5 0 0 0 0-9Z' },
    { id: 'fonts', label: 'Fonts', icon: 'M3 13 7 3h2l4 10h-1.7l-1-2.6H5.7l-1 2.6H3Zm3.3-4.1h3.4L8 4.6 6.3 8.9Z' },
    { id: 'layout', label: 'Layout', icon: 'M2.5 3h11v10h-11V3Zm1.3 1.3v7.4h2.9V4.3H3.8Zm4.2 0v7.4h4.2V4.3H8Z' },
    { id: 'keyboard', label: 'Keyboard', icon: 'M1.5 4.5h13v7h-13v-7Zm2 1.5v1.3h1.3V6H3.5Zm2.6 0v1.3h1.3V6H6.1Zm2.6 0v1.3H10V6H8.7Zm2.6 0v1.3h1.3V6h-1.3ZM5 8.7V10h6V8.7H5Z' },
  ];

  let page = $state<Page>('appearance');
  let subpage = $state<'colorTheme' | null>(null);
  let customOpen = $state(false);
  let scheme = $state<'light' | 'dark'>('light');
  let filter = $state('');
  let recording = $state<string | null>(null);
  let root = $state<HTMLElement | null>(null);

  $effect(() => {
    queueMicrotask(() => root?.focus());
  });

  const presetId = $derived(String(draft.get('colorTheme') ?? DEFAULT_PRESET));
  const preset = $derived(presetById(presetId));

  function go(p: Page) {
    page = p;
    subpage = null;
    recording = null;
  }

  function onRootKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    if (recording !== null) {
      recording = null;
    } else if (subpage !== null) {
      subpage = null;
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  // ------------------------------------------------------------ colours
  const HEX = /^#[0-9a-f]{6}$/i;
  function swatchValue(v: string): string {
    return HEX.test(v) ? v : '#000000';
  }
  const palette = $derived(effectivePalette(draft.config, scheme));

  function pickPreset(id: string) {
    if (id === DEFAULT_PRESET) draft.unset('colorTheme');
    else draft.set('colorTheme', id);
  }

  function setColor(key: string, value: string) {
    if (CSS.supports('color', value)) draft.set(`colors.${scheme}.${key}`, value);
  }

  // ------------------------------------------------------------ fonts
  function fontFamily(role: FontRole): string {
    const v = draft.get(`fonts.${role}.family`);
    return typeof v === 'string' ? v : '';
  }
  function fontSize(role: FontRole): number | null {
    const v = draft.get(`fonts.${role}.size`);
    return typeof v === 'number' ? v : null;
  }
  function setFamily(role: FontRole, value: string) {
    const v = value.trim();
    if (v === '') draft.unset(`fonts.${role}.family`);
    else draft.set(`fonts.${role}.family`, v);
  }
  function setSize(role: FontRole, raw: string) {
    const meta = FONT_ROLE_LABELS[role].size;
    const n = Number.parseFloat(raw);
    if (!meta || !Number.isFinite(n)) return;
    const clamped = Math.min(meta.max, Math.max(meta.min, n));
    draft.set(`fonts.${role}.size`, clamped);
  }
  function sampleStyle(role: FontRole): string {
    const meta = FONT_ROLE_LABELS[role].size;
    const fam = fontFamily(role);
    const size = fontSize(role) ?? meta?.def;
    const family = fam !== '' ? `font-family: ${fam};` : role === 'code' ? 'font-family: var(--font-mono);' : role === 'ui' ? 'font-family: var(--font-ui);' : 'font-family: var(--font-content);';
    const sz = meta && size !== undefined ? (meta.unit === 'px' ? `font-size: ${size}px;` : `font-size: ${size}em;`) : role === 'heading' ? 'font-size: 1.35em; font-weight: 600;' : '';
    return family + sz;
  }
  const SAMPLES: Record<FontRole, string> = {
    ui: 'Explorer · Backlinks · Quick open',
    content: 'Light through sunstone, warm on the page.',
    heading: 'A heading for the Concept',
    code: 'const bundle = await open("docs/");',
  };

  // ------------------------------------------------------------ layout
  function panelOn(key: string, def: boolean): boolean {
    const v = draft.get(`defaults.${key}`);
    return typeof v === 'boolean' ? v : def;
  }
  const editorMode = $derived(String(draft.get('defaults.editorMode') ?? 'read'));

  // ------------------------------------------------------------ keyboard
  const shownCommands = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    return COMMANDS.filter(
      (c) => q === '' || c.label.toLowerCase().includes(q) || draft.binding(c.id).toLowerCase().includes(q),
    );
  });

  function onRecordKeydown(e: KeyboardEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      recording = null;
      return;
    }
    const chord = chordFromEvent(e);
    if (chord === null) return;
    draft.setBinding(id, chord);
    recording = null;
  }

  function defaultOf(id: string): string {
    return COMMANDS.find((c) => c.id === id)?.def ?? '';
  }
</script>

{#snippet dot(path: string)}
  {#if draft.isSet(path)}
    <span class="set-dot" class:edited={draft.isEdited(path)} title={draft.isEdited(path) ? 'Changed (unsaved)' : 'Set in config.json'}></span>
  {/if}
{/snippet}

{#snippet reset(path: string)}
  {#if draft.isSet(path)}
    <button type="button" class="reset" title="Reset to default" aria-label="Reset to default" onclick={() => draft.unset(path)}>↺</button>
  {:else}
    <span class="reset-gap"></span>
  {/if}
{/snippet}

{#snippet mini(pal: Palette)}
  <div class="mini" style="--m-bg:{pal.bg}; --m-el:{pal.bgElevated}; --m-sk:{pal.bgSunken}; --m-tx:{pal.text}; --m-mu:{pal.textMuted}; --m-bd:{pal.border}; --m-ac:{pal.accent};">
    <div class="mini-side">
      <i></i><i></i><i class="on"></i><i></i>
    </div>
    <div class="mini-main">
      <b></b>
      <i></i><i></i><i class="short"></i>
      <span class="mini-btn"></span>
    </div>
  </div>
{/snippet}

{#snippet keycaps(chord: string)}
  {#each chordCaps(chord) as cap, i (i)}<kbd>{cap}</kbd>{/each}
{/snippet}

<div class="va-backdrop" role="presentation" onclick={onclose}></div>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  bind:this={root}
  class="va-dialog"
  role="dialog"
  aria-modal="true"
  aria-label="Settings"
  tabindex="-1"
  onkeydown={onRootKeydown}
  data-testid="settings-variant-a"
>
  <nav class="va-nav" aria-label="Settings sections">
    <div class="va-title">Settings</div>
    {#each PAGES as p (p.id)}
      <button type="button" class="nav-item" class:active={page === p.id} aria-current={page === p.id ? 'page' : undefined} onclick={() => go(p.id)}>
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d={p.icon} fill="currentColor" fill-rule="evenodd" /></svg>
        {p.label}
      </button>
    {/each}
    <div class="nav-foot">
      Changes preview live.<br />Only what you change is written to <code>config.json</code>.
    </div>
  </nav>

  <section class="va-body">
    <header class="va-head">
      {#if subpage === 'colorTheme'}
        <button type="button" class="back" aria-label="Back to Appearance" onclick={() => (subpage = null)}>‹</button>
        <h2><button type="button" class="crumb" onclick={() => (subpage = null)}>Appearance</button> <span class="sep">›</span> Color theme</h2>
      {:else}
        <h2>{PAGES.find((p) => p.id === page)?.label}</h2>
      {/if}
      <button type="button" class="close" aria-label="Close settings" onclick={onclose}>×</button>
    </header>

    <div class="va-scroll">
      {#if page === 'appearance' && subpage === null}
        <div class="row">
          <div class="label">
            <div class="name">{@render dot('theme')}Theme</div>
            <div class="hint">Follow the system, or always use light or dark.</div>
          </div>
          <div class="control">
            <div class="segmented" role="radiogroup" aria-label="Theme">
              {#each THEME_MODES as m (m.id)}
                <button
                  type="button"
                  role="radio"
                  aria-checked={(draft.get('theme') ?? 'system') === m.id}
                  class:on={(draft.get('theme') ?? 'system') === m.id}
                  onclick={() => (m.id === 'system' ? draft.unset('theme') : draft.set('theme', m.id))}>{m.label}</button
                >
              {/each}
            </div>
            {@render reset('theme')}
          </div>
        </div>

        <div class="row">
          <div class="label">
            <div class="name">{@render dot('colorTheme')}Color theme</div>
            <div class="hint">A palette for both light and dark. Fine-tune single colours on the theme page.</div>
          </div>
          <div class="control">
            <button type="button" class="current-theme" onclick={() => (subpage = 'colorTheme')}>
              <span class="pair">{@render mini(preset.light)}{@render mini(preset.dark)}</span>
              <span class="ct-name">
                {preset.name}
                {#if draft.isSet('colors')}<small>+ custom colours</small>{/if}
              </span>
              <span class="browse">Browse themes ›</span>
            </button>
          </div>
        </div>
      {:else if page === 'appearance' && subpage === 'colorTheme'}
        <div class="preset-grid" role="radiogroup" aria-label="Color theme">
          {#each PRESETS as t (t.id)}
            <button type="button" class="preset" class:on={presetId === t.id} role="radio" aria-checked={presetId === t.id} onclick={() => pickPreset(t.id)}>
              <span class="pair">{@render mini(t.light)}{@render mini(t.dark)}</span>
              <span class="preset-name">
                {t.name}
                {#if presetId === t.id}<span class="check">✓</span>{/if}
              </span>
            </button>
          {/each}
        </div>

        <div class="disclosure">
          <button type="button" class="disc-head" aria-expanded={customOpen} onclick={() => (customOpen = !customOpen)}>
            <span class="chev" class:open={customOpen}>›</span>
            Customize colours
            {@render dot('colors')}
            <span class="disc-hint">Override single colours on top of {preset.name}</span>
          </button>
          {#if customOpen}
            <div class="tabs" role="tablist">
              {#each ['light', 'dark'] as const as s (s)}
                <button type="button" role="tab" aria-selected={scheme === s} class:on={scheme === s} onclick={() => (scheme = s)}>
                  {s === 'light' ? 'Light' : 'Dark'}
                  {@render dot(`colors.${s}`)}
                </button>
              {/each}
            </div>
            <div class="color-list">
              {#each COLOR_KEYS as key (key)}
                {@const path = `colors.${scheme}.${key}`}
                <div class="color-row">
                  <label class="swatch" style="background: {palette[key]}">
                    <input type="color" value={swatchValue(palette[key])} oninput={(e) => setColor(key, e.currentTarget.value)} aria-label="{COLOR_LABELS[key]} colour" />
                  </label>
                  <span class="color-name">{@render dot(path)}{COLOR_LABELS[key]}</span>
                  <input
                    class="hex"
                    type="text"
                    spellcheck="false"
                    value={palette[key]}
                    onchange={(e) => setColor(key, e.currentTarget.value.trim())}
                    aria-label="{COLOR_LABELS[key]} value"
                  />
                  {@render reset(path)}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {:else if page === 'fonts'}
        <datalist id="va-font-suggestions">
          {#each FONT_SUGGESTIONS as f (f)}<option value={f}></option>{/each}
        </datalist>
        {#each FONT_ROLES as role (role)}
          {@const meta = FONT_ROLE_LABELS[role]}
          <div class="font-row">
            <div class="font-top">
              <div class="label">
                <div class="name">{@render dot(`fonts.${role}`)}{meta.label}</div>
                <div class="hint">{meta.hint}</div>
              </div>
              <div class="control">
                <input
                  class="family"
                  type="text"
                  list="va-font-suggestions"
                  placeholder={meta.defaultFamily}
                  value={fontFamily(role)}
                  onchange={(e) => setFamily(role, e.currentTarget.value)}
                  aria-label="{meta.label} font family"
                />
                {#if meta.size}
                  <span class="size">
                    <button type="button" aria-label="Smaller" onclick={() => setSize(role, String((fontSize(role) ?? meta.size.def) - meta.size.step))}>−</button>
                    <input
                      type="number"
                      min={meta.size.min}
                      max={meta.size.max}
                      step={meta.size.step}
                      placeholder={String(meta.size.def)}
                      value={fontSize(role) ?? ''}
                      onchange={(e) => (e.currentTarget.value === '' ? draft.unset(`fonts.${role}.size`) : setSize(role, e.currentTarget.value))}
                      aria-label="{meta.label} font size"
                    />
                    <span class="unit">{meta.size.unit}</span>
                    <button type="button" aria-label="Larger" onclick={() => setSize(role, String((fontSize(role) ?? meta.size.def) + meta.size.step))}>+</button>
                  </span>
                {:else}
                  <span class="size-none">size per level</span>
                {/if}
                {#if draft.isSet(`fonts.${role}.family`) || draft.isSet(`fonts.${role}.size`)}
                  <button
                    type="button"
                    class="reset"
                    title="Reset family and size"
                    aria-label="Reset {meta.label} font"
                    onclick={() => {
                      draft.unset(`fonts.${role}.family`);
                      draft.unset(`fonts.${role}.size`);
                    }}>↺</button
                  >
                {:else}
                  <span class="reset-gap"></span>
                {/if}
              </div>
            </div>
            <div class="sample" style={sampleStyle(role)}>{SAMPLES[role]}</div>
            {#if draft.isSet(`fonts.${role}.files`)}
              <div class="files-note">Font files from config.json are kept as they are.</div>
            {/if}
          </div>
        {/each}
      {:else if page === 'layout'}
        <p class="intro">When a Bundle opens for the first time. Bundles you've opened before remember their own layout.</p>
        <div class="row">
          <div class="label">
            <div class="name">{@render dot('defaults.editorMode')}Open Concepts in</div>
            <div class="hint">Read shows the rendered page; Editing puts the cursor in it.</div>
          </div>
          <div class="control">
            <div class="segmented" role="radiogroup" aria-label="Open Concepts in">
              {#each EDITOR_MODES as m (m.id)}
                <button
                  type="button"
                  role="radio"
                  aria-checked={editorMode === m.id}
                  class:on={editorMode === m.id}
                  onclick={() => (m.id === 'read' ? draft.unset('defaults.editorMode') : draft.set('defaults.editorMode', m.id))}>{m.label}</button
                >
              {/each}
            </div>
            {@render reset('defaults.editorMode')}
          </div>
        </div>
        <div class="panel-grid">
          {#each PANEL_DEFAULTS as p (p.key)}
            {@const on = panelOn(p.key, p.def)}
            <label class="toggle-row">
              <span class="name">{@render dot(`defaults.${p.key}`)}{p.label}</span>
              <span class="tail">
                <input
                  type="checkbox"
                  class="switch"
                  checked={on}
                  onchange={(e) => (e.currentTarget.checked === p.def ? draft.unset(`defaults.${p.key}`) : draft.set(`defaults.${p.key}`, e.currentTarget.checked))}
                />
              </span>
            </label>
          {/each}
        </div>
      {:else if page === 'keyboard'}
        <input class="kb-filter" type="search" placeholder="Filter by command or key…" bind:value={filter} aria-label="Filter shortcuts" />
        {#each COMMAND_GROUPS as group (group)}
          {@const cmds = shownCommands.filter((c) => c.group === group)}
          {#if cmds.length > 0}
            <h3 class="group">{group}</h3>
            <div class="kb-table">
              {#each cmds as c (c.id)}
                {@const chord = draft.binding(c.id)}
                {@const clash = conflicts(chord, c.id, (id) => draft.binding(id))}
                <div class="kb-row" class:clash={clash.length > 0}>
                  <span class="kb-label">
                    {@render dot(`keybindings.${c.id}`)}{c.label}
                    {#if c.scope === 'editor'}<span class="scope">editor</span>{/if}
                  </span>
                  <span class="kb-chord">
                    {#if recording === c.id}
                      <button
                        type="button"
                        class="chord recording"
                        data-own-arrows
                        onkeydown={(e) => onRecordKeydown(e, c.id)}
                        onblur={() => (recording = null)}
                        {@attach (el) => el.focus()}>Press keys… <small>Esc to cancel</small></button
                      >
                    {:else}
                      <button type="button" class="chord" title="Click to change" onclick={() => (recording = c.id)}>{@render keycaps(chord)}</button>
                    {/if}
                    {#if chord !== defaultOf(c.id)}
                      <button type="button" class="reset" title="Reset to {defaultOf(c.id)}" aria-label="Reset shortcut" onclick={() => draft.unset(`keybindings.${c.id}`)}>↺</button>
                    {:else}
                      <span class="reset-gap"></span>
                    {/if}
                  </span>
                  {#if clash.length > 0}
                    <span class="clash-note">⚠ Also bound to {clash.map((x) => x.label).join(', ')}</span>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        {/each}
        {#if shownCommands.length === 0}
          <p class="intro">No shortcut matches “{filter}”.</p>
        {/if}
      {/if}
    </div>
  </section>
</div>

<style>
  .va-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1300;
    background: color-mix(in srgb, var(--bg-sunken) 55%, transparent);
    backdrop-filter: blur(2px);
  }

  .va-dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 1301;
    width: min(56rem, 92vw);
    height: min(38rem, 85vh);
    display: grid;
    grid-template-columns: 13rem 1fr;
    overflow: hidden;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg, 14px);
    background: var(--bg-elevated);
    color: var(--text);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.22);
    font-family: var(--font-ui);
    outline: none;
  }

  /* ---------------------------------------------------------- nav */
  .va-nav {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 1rem 0.6rem;
    background: var(--bg-sunken);
    border-right: 1px solid var(--border);
  }
  .va-title {
    padding: 0 0.6rem 0.7rem;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.45rem 0.6rem;
    border: 0;
    border-radius: var(--radius-md);
    background: none;
    color: var(--text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .nav-item svg {
    color: var(--text-muted);
  }
  .nav-item:hover {
    background: var(--hover);
  }
  .nav-item.active {
    background: var(--accent-soft);
    color: var(--text);
    font-weight: 500;
  }
  .nav-item.active svg {
    color: var(--accent);
  }
  .nav-foot {
    margin-top: auto;
    padding: 0 0.6rem;
    font-size: 0.75rem;
    line-height: 1.45;
    color: var(--text-faint, var(--text-muted));
  }
  .nav-foot code {
    font-size: 0.95em;
  }

  /* ---------------------------------------------------------- body */
  .va-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .va-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.9rem 1rem 0.7rem 1.5rem;
    border-bottom: 1px solid var(--border);
  }
  .va-head h2 {
    flex: 1;
    margin: 0;
    font-size: 1.1rem;
    font-weight: 600;
  }
  .crumb {
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-muted);
    font: inherit;
    cursor: pointer;
  }
  .crumb:hover {
    color: var(--accent);
  }
  .sep {
    color: var(--text-faint, var(--text-muted));
    font-weight: 400;
  }
  .back,
  .close {
    width: 1.9rem;
    height: 1.9rem;
    border: 0;
    border-radius: var(--radius-md);
    background: none;
    color: var(--text-muted);
    font-size: 1.3rem;
    line-height: 1;
    cursor: pointer;
  }
  .back {
    margin-left: -0.6rem;
  }
  .back:hover,
  .close:hover {
    background: var(--hover);
    color: var(--text);
  }
  .va-scroll {
    flex: 1;
    overflow: auto;
    padding: 0.4rem 1.5rem 5rem;
  }

  /* ---------------------------------------------------------- rows */
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    padding: 0.95rem 0;
    border-bottom: 1px solid var(--border);
  }
  .label {
    min-width: 0;
  }
  .name {
    display: flex;
    align-items: center;
    font-weight: 500;
  }
  .hint {
    margin-top: 0.15rem;
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .intro {
    margin: 0.8rem 0 0.3rem;
    font-size: 0.875rem;
    color: var(--text-muted);
  }
  .control {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex: none;
  }

  .set-dot {
    flex: none;
    width: 0.4rem;
    height: 0.4rem;
    margin-right: 0.45rem;
    border-radius: 50%;
    background: var(--text-muted);
  }
  .set-dot.edited {
    background: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .reset,
  .reset-gap {
    flex: none;
    width: 1.6rem;
    height: 1.6rem;
  }
  .reset {
    border: 0;
    border-radius: var(--radius-sm, 6px);
    background: none;
    color: var(--text-muted);
    font-size: 0.95rem;
    cursor: pointer;
  }
  .reset:hover {
    background: var(--hover);
    color: var(--accent);
  }

  .segmented {
    display: inline-flex;
    padding: 0.15rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-sunken);
  }
  .segmented button {
    padding: 0.3rem 0.85rem;
    border: 0;
    border-radius: calc(var(--radius-md) - 2px);
    background: none;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.875rem;
    cursor: pointer;
  }
  .segmented button.on {
    background: var(--bg-elevated);
    color: var(--text);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  }

  /* ---------------------------------------------------------- theme */
  .current-theme {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.4rem 0.6rem 0.4rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .current-theme:hover {
    border-color: var(--border-strong);
  }
  .current-theme .pair {
    width: 5.5rem;
  }
  .ct-name {
    display: flex;
    flex-direction: column;
    text-align: left;
    font-weight: 500;
  }
  .ct-name small {
    font-weight: 400;
    color: var(--text-muted);
  }
  .browse {
    color: var(--accent);
    font-size: 0.85rem;
    white-space: nowrap;
  }

  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    overflow: hidden;
    border-radius: 6px;
    border: 1px solid var(--border);
  }
  .mini {
    display: grid;
    grid-template-columns: 28% 1fr;
    aspect-ratio: 4 / 3;
    background: var(--m-bg);
  }
  .mini-side {
    display: flex;
    flex-direction: column;
    gap: 9%;
    padding: 18% 14%;
    background: var(--m-sk);
    border-right: 1px solid var(--m-bd);
  }
  .mini-side i {
    display: block;
    height: 3px;
    border-radius: 2px;
    background: var(--m-mu);
    opacity: 0.55;
  }
  .mini-side i.on {
    background: var(--m-ac);
    opacity: 1;
  }
  .mini-main {
    display: flex;
    flex-direction: column;
    gap: 7%;
    padding: 14% 12%;
  }
  .mini-main b {
    display: block;
    width: 60%;
    height: 5px;
    border-radius: 2px;
    background: var(--m-tx);
  }
  .mini-main i {
    display: block;
    height: 3px;
    border-radius: 2px;
    background: var(--m-mu);
    opacity: 0.7;
  }
  .mini-main i.short {
    width: 55%;
  }
  .mini-btn {
    display: block;
    width: 38%;
    height: 7px;
    margin-top: auto;
    border-radius: 3px;
    background: var(--m-ac);
  }

  .preset-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
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
    cursor: pointer;
    text-align: left;
  }
  .preset:hover {
    border-color: var(--border-strong);
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

  .disclosure {
    border-top: 1px solid var(--border);
    padding-top: 0.6rem;
  }
  .disc-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0;
    border: 0;
    background: none;
    color: var(--text);
    font: inherit;
    font-weight: 500;
    cursor: pointer;
    text-align: left;
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
  .disc-hint {
    margin-left: auto;
    font-weight: 400;
    font-size: 0.85rem;
    color: var(--text-muted);
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
  .color-list {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.15rem 1.5rem;
  }
  .color-row {
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
    border-radius: 50%;
    border: 1px solid var(--border-strong);
    cursor: pointer;
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
  .hex {
    width: 6.5rem;
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 6px);
    background: var(--bg);
    color: var(--text);
    font: 0.8rem var(--font-mono, monospace);
  }

  /* ---------------------------------------------------------- fonts */
  .font-row {
    padding: 0.95rem 0;
    border-bottom: 1px solid var(--border);
  }
  .font-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
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
  .family:focus,
  .hex:focus,
  .kb-filter:focus,
  .size input:focus {
    outline: 2px solid var(--accent-ring);
    outline-offset: -1px;
  }
  .size {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg);
    overflow: hidden;
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
    -moz-appearance: textfield;
    appearance: textfield;
  }
  .size input::-webkit-inner-spin-button {
    -webkit-appearance: none;
  }
  .unit {
    padding: 0 0.2rem 0 0.15rem;
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .size-none {
    width: 7.75rem;
    text-align: center;
    font-size: 0.8rem;
    color: var(--text-faint, var(--text-muted));
  }
  .sample {
    margin-top: 0.6rem;
    padding: 0.6rem 0.8rem;
    border-radius: var(--radius-md);
    background: var(--bg);
    border: 1px dashed var(--border);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .files-note {
    margin-top: 0.35rem;
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  /* ---------------------------------------------------------- layout */
  .panel-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0 1.5rem;
    padding-top: 0.4rem;
  }
  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.65rem 0;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
  }
  .toggle-row .name {
    font-weight: 400;
  }
  .switch {
    appearance: none;
    position: relative;
    width: 2.1rem;
    height: 1.2rem;
    margin: 0;
    border-radius: 999px;
    background: var(--border-strong);
    cursor: pointer;
    transition: background 120ms;
  }
  .switch::after {
    content: '';
    position: absolute;
    top: 0.15rem;
    left: 0.15rem;
    width: 0.9rem;
    height: 0.9rem;
    border-radius: 50%;
    background: var(--bg-elevated);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
    transition: transform 120ms;
  }
  .switch:checked {
    background: var(--accent);
  }
  .switch:checked::after {
    transform: translateX(0.9rem);
  }
  .switch:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: 2px;
  }

  /* ---------------------------------------------------------- keyboard */
  .kb-filter {
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
  .group {
    margin: 1.1rem 0 0.3rem;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .kb-table {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .kb-row {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    padding: 0.3rem 0.4rem 0.3rem 0.8rem;
    border-bottom: 1px solid var(--border);
  }
  .kb-row:last-child {
    border-bottom: 0;
  }
  .kb-row:hover {
    background: var(--hover);
  }
  .kb-row.clash {
    background: color-mix(in srgb, var(--danger) 7%, transparent);
  }
  .kb-label {
    display: flex;
    align-items: center;
    gap: 0.1rem;
    font-size: 0.9rem;
  }
  .scope {
    margin-left: 0.5rem;
    padding: 0 0.4rem;
    border-radius: 999px;
    background: var(--bg-sunken);
    color: var(--text-muted);
    font-size: 0.7rem;
  }
  .kb-chord {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .chord {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    min-width: 7rem;
    justify-content: flex-end;
    padding: 0.2rem 0.35rem;
    border: 1px solid transparent;
    border-radius: var(--radius-sm, 6px);
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .chord:hover {
    border-color: var(--border-strong);
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
  kbd {
    min-width: 1.1rem;
    padding: 0.05rem 0.35rem;
    border: 1px solid var(--border-strong);
    border-bottom-width: 2px;
    border-radius: 4px;
    background: var(--bg);
    color: var(--text);
    font: 0.75rem var(--font-ui);
    text-align: center;
  }
  .clash-note {
    grid-column: 1 / -1;
    padding: 0.1rem 0 0.2rem;
    font-size: 0.8rem;
    color: var(--danger);
  }
</style>
