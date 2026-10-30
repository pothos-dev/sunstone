<script lang="ts">
  // PROTOTYPE — Variant B: "Full page, one scroll". Throwaway.
  //
  // Settings take over the whole window like a system-settings page: a search
  // bar filters every row across sections, a sticky table of contents tracks
  // the scroll, and the individual colours open as an in-page subpage.
  import { fly } from 'svelte/transition';
  import { theme } from '$lib/state/theme.svelte';
  import type { BaseColor } from '$lib/state/themeColors';
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
    PRESETS,
    THEME_MODES,
    type FontRole,
    type Palette,
  } from './model';

  interface Props {
    onclose: () => void;
  }
  let { onclose }: Props = $props();

  type SectionId = 'appearance' | 'colours' | 'fonts' | 'layout' | 'keyboard';
  const SECTIONS: { id: SectionId; label: string }[] = [
    { id: 'appearance', label: 'Appearance' },
    { id: 'colours', label: 'Colours' },
    { id: 'fonts', label: 'Fonts' },
    { id: 'layout', label: 'Layout' },
    { id: 'keyboard', label: 'Keyboard' },
  ];

  let query = $state('');
  let subpage = $state<'colours' | null>(null);
  let recording = $state<string | null>(null);
  let activeSection = $state<SectionId>('appearance');
  let scroller = $state<HTMLElement | null>(null);
  let searchInput = $state<HTMLInputElement | null>(null);

  const q = $derived(query.trim().toLowerCase());
  const matches = (...parts: string[]) => q === '' || parts.join(' ').toLowerCase().includes(q);

  // ---- per-row match tables (what the search sees) ----
  const showThemeMode = $derived(matches('Theme mode', 'appearance light dark system scheme'));
  const showPresets = $derived(matches('Colour theme color preset palette', ...PRESETS.map((p) => p.name)));
  const showIndividual = $derived(
    matches('Individual colours color custom hex', ...COLOR_KEYS.map((k) => COLOR_LABELS[k])),
  );
  const fontRows = $derived(
    FONT_ROLES.filter((r) => matches(FONT_ROLE_LABELS[r].label, FONT_ROLE_LABELS[r].hint, 'font family size typeface')),
  );
  const panelRows = $derived(PANEL_DEFAULTS.filter((p) => matches(p.label, 'layout panel default open sidebar')));
  const showEditorMode = $derived(matches('Default editor mode read editing', 'layout'));
  const commandRows = $derived(
    COMMANDS.filter((c) => matches(c.label, c.group, 'keyboard shortcut keybinding', draft.binding(c.id), chordCaps(draft.binding(c.id)).join(' '))),
  );

  const visible = $derived<Record<SectionId, boolean>>({
    appearance: showThemeMode,
    colours: showPresets || showIndividual,
    fonts: fontRows.length > 0,
    layout: panelRows.length > 0 || showEditorMode,
    keyboard: commandRows.length > 0,
  });
  const anyVisible = $derived(Object.values(visible).some(Boolean));

  // Searching always shows the main page.
  $effect(() => {
    if (q !== '') subpage = null;
  });

  $effect(() => {
    queueMicrotask(() => searchInput?.focus());
  });

  // ---- scroll spy ----
  function onScroll() {
    if (!scroller) return;
    const top = scroller.scrollTop + 120;
    let current: SectionId = SECTIONS[0].id;
    for (const s of SECTIONS) {
      const el = scroller.querySelector<HTMLElement>(`#settings-b-${s.id}`);
      if (el && el.offsetTop <= top) current = s.id;
    }
    activeSection = current;
  }

  function jump(id: SectionId) {
    subpage = null;
    queueMicrotask(() =>
      scroller?.querySelector(`#settings-b-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  }

  function onRootKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    if (subpage !== null) {
      subpage = null;
    } else if (query !== '') {
      query = '';
    } else {
      return; // let the global peel close the page
    }
    e.preventDefault();
    e.stopPropagation();
  }

  // ---- helpers over the draft ----
  const themeMode = $derived((draft.get('theme') as string | undefined) ?? 'system');
  function setThemeMode(id: string) {
    if (id === 'system') draft.unset('theme');
    else draft.set('theme', id);
  }

  const presetId = $derived((draft.get('colorTheme') as string | undefined) ?? DEFAULT_PRESET);
  function choosePreset(id: string) {
    if (id === DEFAULT_PRESET) draft.unset('colorTheme');
    else draft.set('colorTheme', id);
  }

  const customCount = $derived(
    (['light', 'dark'] as const).reduce(
      (n, s) => n + COLOR_KEYS.filter((k) => draft.isSet(`colors.${s}.${k}`)).length,
      0,
    ),
  );

  function hex(v: string): string {
    return /^#[0-9a-f]{6}$/i.test(v) ? v : /^#[0-9a-f]{3}$/i.test(v) ? '#' + [...v.slice(1)].map((c) => c + c).join('') : '#000000';
  }
  function setColor(scheme: 'light' | 'dark', key: BaseColor, value: string) {
    if (CSS.supports('color', value)) draft.set(`colors.${scheme}.${key}`, value);
  }

  const ROLE_VAR: Record<FontRole, string> = {
    ui: 'var(--font-ui)',
    content: 'var(--font-content)',
    heading: 'var(--font-heading)',
    code: 'var(--font-mono)',
  };
  const SPECIMEN: Record<FontRole, string> = {
    ui: 'Explorer · Quick open · Switch Bundle',
    content: 'Light through sunstone falls warm across the page.',
    heading: 'A Concept, well named',
    code: 'const bundle = await open("~/notes");',
  };
  function family(role: FontRole): string {
    const v = draft.get(`fonts.${role}.family`);
    return typeof v === 'string' ? v : '';
  }
  function size(role: FontRole): number {
    const v = draft.get(`fonts.${role}.size`);
    const spec = FONT_ROLE_LABELS[role].size;
    return typeof v === 'number' ? v : (spec?.def ?? 0);
  }
  function setFamily(role: FontRole, v: string) {
    const t = v.trim();
    if (t === '') draft.unset(`fonts.${role}.family`);
    else draft.set(`fonts.${role}.family`, t);
  }
  function specimenSize(role: FontRole): string {
    const spec = FONT_ROLE_LABELS[role].size;
    if (spec === null) return '1.6rem';
    return spec.unit === 'px' ? `${size(role) * 1.25}px` : `${size(role) * 1.2}rem`;
  }

  function panelValue(key: string, def: boolean): boolean {
    const v = draft.get(`defaults.${key}`);
    return typeof v === 'boolean' ? v : def;
  }
  function setPanel(key: string, def: boolean, v: boolean) {
    if (v === def) draft.unset(`defaults.${key}`);
    else draft.set(`defaults.${key}`, v);
  }
  const editorMode = $derived((draft.get('defaults.editorMode') as string | undefined) ?? 'read');
  function setEditorMode(id: string) {
    if (id === 'read') draft.unset('defaults.editorMode');
    else draft.set('defaults.editorMode', id);
  }

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
  function clashes(id: string) {
    return conflicts(draft.binding(id), id, (x) => draft.binding(x));
  }
</script>

{#snippet mini(pal: Palette, label?: string)}
  <div class="mini" style="--m-bg:{pal.bg};--m-el:{pal.bgElevated};--m-sunk:{pal.bgSunken};--m-text:{pal.text};--m-muted:{pal.textMuted};--m-border:{pal.border};--m-accent:{pal.accent};--m-tag:{pal.tagText}" aria-hidden="true">
    <div class="mini-side">
      <i style="width:70%"></i><i class="on" style="width:85%"></i><i style="width:55%"></i><i style="width:65%"></i>
    </div>
    <div class="mini-main">
      <b></b>
      <i style="width:92%"></i><i style="width:80%"></i><i style="width:86%"></i>
      <span class="mini-tag"></span>
      {#if label}<em>{label}</em>{/if}
    </div>
  </div>
{/snippet}

{#snippet modified(path: string, reset: () => void)}
  {#if draft.isSet(path) || draft.isEdited(path)}
    <span class="modified" class:pending={draft.isEdited(path)}>
      {draft.isEdited(path) ? 'Unsaved' : 'Modified'}
      {#if draft.isSet(path)}<button type="button" class="link" onclick={reset}>Reset</button>{/if}
    </span>
  {/if}
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="page"
  role="dialog"
  aria-modal="true"
  aria-label="Settings"
  tabindex="-1"
  onkeydown={onRootKeydown}
  data-testid="settings-b"
>
  <header class="topbar">
    <button type="button" class="back" onclick={onclose}>
      <span aria-hidden="true">←</span> Back to Bundle
    </button>
    <div class="search">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.5" />
        <line x1="10.4" y1="10.4" x2="14" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
      <input
        bind:this={searchInput}
        bind:value={query}
        type="search"
        placeholder="Search settings"
        aria-label="Search settings"
      />
    </div>
    <div class="topbar-end">
      {#if draft.dirty}<span class="unsaved-dot">{draft.edits.size} unsaved</span>{/if}
    </div>
  </header>

  <div class="body" bind:this={scroller} onscroll={onScroll}>
    <nav class="toc" aria-label="Settings sections">
      <h1>Settings</h1>
      <ul>
        {#each SECTIONS as s (s.id)}
          <li>
            <button
              type="button"
              class:active={subpage === null && activeSection === s.id}
              class:dim={!visible[s.id]}
              onclick={() => jump(s.id)}
            >
              {s.label}
            </button>
            {#if s.id === 'colours' && subpage === 'colours'}
              <button type="button" class="sub active" onclick={() => (subpage = 'colours')}>Individual colours</button>
            {/if}
          </li>
        {/each}
      </ul>
      <p class="toc-note">Saved to <code>config.json</code> — only what you change here.</p>
    </nav>

    <main class="column">
      {#if subpage === 'colours'}
        <div class="subpage" in:fly={{ x: 48, duration: 200 }}>
          <div class="crumbs">
            <button type="button" class="link" onclick={() => (subpage = null)}>Settings</button>
            <span aria-hidden="true">/</span>
            <span>Colours</span>
          </div>
          <h2 class="sub-title">Individual colours</h2>
          <p class="lede">
            Layered over <strong>{PRESETS.find((p) => p.id === presetId)?.name}</strong>. Every other shade
            of the interface is mixed from these twelve.
          </p>
          <div class="schemes">
            {#each ['light', 'dark'] as const as scheme (scheme)}
              {@const pal = effectivePalette(draft.config, scheme)}
              <section class="scheme" class:current={theme.resolved === scheme}>
                <header>
                  <h3>{scheme === 'light' ? 'Light' : 'Dark'}</h3>
                  {#if theme.resolved === scheme}<span class="now">Showing now</span>{/if}
                </header>
                {@render mini(pal)}
                <ul class="swatches">
                  {#each COLOR_KEYS as key (key)}
                    {@const path = `colors.${scheme}.${key}`}
                    <li class:set={draft.isSet(path)}>
                      <label class="swatch" style="background:{pal[key]}">
                        <input
                          type="color"
                          value={hex(pal[key])}
                          oninput={(e) => setColor(scheme, key, e.currentTarget.value)}
                          aria-label="{COLOR_LABELS[key]} ({scheme})"
                        />
                      </label>
                      <span class="sw-label">{COLOR_LABELS[key]}</span>
                      <input
                        class="hex"
                        type="text"
                        value={pal[key]}
                        spellcheck="false"
                        onchange={(e) => setColor(scheme, key, e.currentTarget.value.trim())}
                        aria-label="{COLOR_LABELS[key]} ({scheme}) value"
                      />
                      <button
                        type="button"
                        class="link reset"
                        disabled={!draft.isSet(path)}
                        onclick={() => draft.unset(path)}
                        title="Use the theme's colour">Reset</button
                      >
                    </li>
                  {/each}
                </ul>
              </section>
            {/each}
          </div>
        </div>
      {:else}
        <div in:fly={{ x: -48, duration: 200 }}>
          {#if !anyVisible}
            <p class="empty">No settings match “{query}”.</p>
          {/if}

          <!-- Appearance -->
          {#if visible.appearance}
            <section id="settings-b-appearance" class="section">
              <h2>Appearance</h2>
              <div class="row stacked">
                <div class="meta">
                  <span class="label">Theme mode {@render modified('theme', () => draft.unset('theme'))}</span>
                  <span class="desc">System follows your OS and switches with it.</span>
                </div>
                <div class="modes" role="radiogroup" aria-label="Theme mode">
                  {#each THEME_MODES as m (m.id)}
                    {@const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0]}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={themeMode === m.id}
                      class="mode"
                      class:selected={themeMode === m.id}
                      onclick={() => setThemeMode(m.id)}
                    >
                      <span class="mode-thumb" class:split={m.id === 'system'}>
                        {#if m.id === 'system'}
                          <span class="half left">{@render mini(effectivePalette(draft.config, 'light'))}</span>
                          <span class="half right">{@render mini(effectivePalette(draft.config, 'dark'))}</span>
                        {:else}
                          {@render mini(effectivePalette(draft.config, m.id))}
                        {/if}
                      </span>
                      <span class="mode-name">{m.label}</span>
                      <span class="sr">{preset.name}</span>
                    </button>
                  {/each}
                </div>
              </div>
            </section>
          {/if}

          <!-- Colours -->
          {#if visible.colours}
            <section id="settings-b-colours" class="section">
              <h2>Colours</h2>
              {#if showPresets}
                <div class="row stacked">
                  <div class="meta">
                    <span class="label">Colour theme {@render modified('colorTheme', () => draft.unset('colorTheme'))}</span>
                    <span class="desc">
                      Each theme has a light and a dark version; the previews show the
                      {theme.resolved} one.
                    </span>
                  </div>
                  <div class="strip" data-own-arrows>
                    {#each PRESETS as t (t.id)}
                      <button
                        type="button"
                        class="preset"
                        class:selected={presetId === t.id}
                        aria-pressed={presetId === t.id}
                        onclick={() => choosePreset(t.id)}
                      >
                        {@render mini(t[theme.resolved])}
                        <span class="preset-name">
                          {t.name}
                          {#if presetId === t.id}<span class="check" aria-hidden="true">✓</span>{/if}
                        </span>
                        <span class="dots" aria-hidden="true">
                          {#each ['bg', 'text', 'accent', 'tagText'] as const as k (k)}
                            <i style="background:{t[theme.resolved][k]}"></i>
                          {/each}
                        </span>
                      </button>
                    {/each}
                  </div>
                </div>
              {/if}
              {#if showIndividual}
                <button type="button" class="row nav-row" onclick={() => (subpage = 'colours')}>
                  <span class="meta">
                    <span class="label">Individual colours</span>
                    <span class="desc">
                      {customCount === 0
                        ? 'Fine-tune any of the twelve base colours, per scheme.'
                        : `${customCount} colour${customCount === 1 ? '' : 's'} set on top of the theme.`}
                    </span>
                  </span>
                  <span class="nav-end">
                    <span class="tiny-dots" aria-hidden="true">
                      {#each COLOR_KEYS.slice(0, 6) as k (k)}
                        <i style="background:{effectivePalette(draft.config, theme.resolved)[k]}"></i>
                      {/each}
                    </span>
                    Edit individual colours <span aria-hidden="true">→</span>
                  </span>
                </button>
              {/if}
            </section>
          {/if}

          <!-- Fonts -->
          {#if visible.fonts}
            <section id="settings-b-fonts" class="section">
              <h2>Fonts</h2>
              <datalist id="settings-b-fonts-list">
                {#each FONT_SUGGESTIONS as f (f)}<option value={f}></option>{/each}
              </datalist>
              {#each fontRows as role (role)}
                {@const spec = FONT_ROLE_LABELS[role]}
                <div class="row font-row">
                  <div class="meta">
                    <span class="label">{spec.label} {@render modified(`fonts.${role}.family`, () => draft.unset(`fonts.${role}.family`))}</span>
                    <span class="desc">{spec.hint}</span>
                  </div>
                  <div class="font-controls">
                    <input
                      type="text"
                      list="settings-b-fonts-list"
                      placeholder={spec.defaultFamily}
                      value={family(role)}
                      onchange={(e) => setFamily(role, e.currentTarget.value)}
                      aria-label="{spec.label} font family"
                    />
                    {#if spec.size}
                      <div class="size">
                        <input
                          type="range"
                          min={spec.size.min}
                          max={spec.size.max}
                          step={spec.size.step}
                          value={size(role)}
                          oninput={(e) => draft.set(`fonts.${role}.size`, Number(e.currentTarget.value))}
                          aria-label="{spec.label} size"
                        />
                        <output>{spec.size.unit === 'px' ? `${size(role)} px` : `${size(role).toFixed(2)}×`}</output>
                        {#if draft.isSet(`fonts.${role}.size`)}
                          <button type="button" class="link" onclick={() => draft.unset(`fonts.${role}.size`)}>Reset</button>
                        {/if}
                      </div>
                    {/if}
                  </div>
                  <p
                    class="specimen"
                    class:code={role === 'code'}
                    style="font-family:{family(role) || ROLE_VAR[role]};font-size:{specimenSize(role)}"
                  >
                    {SPECIMEN[role]}
                  </p>
                </div>
              {/each}
            </section>
          {/if}

          <!-- Layout -->
          {#if visible.layout}
            <section id="settings-b-layout" class="section">
              <h2>Layout</h2>
              <p class="section-note">Applies to Bundles you open for the first time. A Bundle you've used remembers its own layout.</p>
              <div class="toggles">
                {#each panelRows as p (p.key)}
                  {@const on = panelValue(p.key, p.def)}
                  <label class="row toggle-row">
                    <span class="meta">
                      <span class="label">{p.label} {@render modified(`defaults.${p.key}`, () => draft.unset(`defaults.${p.key}`))}</span>
                    </span>
                    <input
                      type="checkbox"
                      role="switch"
                      class="switch"
                      checked={on}
                      onchange={(e) => setPanel(p.key, p.def, e.currentTarget.checked)}
                    />
                  </label>
                {/each}
              </div>
              {#if showEditorMode}
                <div class="row">
                  <div class="meta">
                    <span class="label">Open Concepts in {@render modified('defaults.editorMode', () => draft.unset('defaults.editorMode'))}</span>
                    <span class="desc">Read shows the rendered page; Editing puts the cursor in the text.</span>
                  </div>
                  <div class="segmented" role="radiogroup" aria-label="Default editor mode">
                    {#each EDITOR_MODES as m (m.id)}
                      <button
                        type="button"
                        role="radio"
                        aria-checked={editorMode === m.id}
                        class:selected={editorMode === m.id}
                        onclick={() => setEditorMode(m.id)}>{m.label}</button
                      >
                    {/each}
                  </div>
                </div>
              {/if}
            </section>
          {/if}

          <!-- Keyboard -->
          {#if visible.keyboard}
            <section id="settings-b-keyboard" class="section">
              <h2>Keyboard</h2>
              <p class="section-note">Click a shortcut, then press the new keys. Esc cancels.</p>
              <div class="cheats">
                {#each COMMAND_GROUPS as g (g)}
                  {@const rows = commandRows.filter((c) => c.group === g)}
                  {#if rows.length > 0}
                    <div class="cheat-card">
                      <h3>{g}</h3>
                      <ul>
                        {#each rows as c (c.id)}
                          {@const clash = clashes(c.id)}
                          {@const set = draft.isSet(`keybindings.${c.id}`)}
                          <li class:clash={clash.length > 0}>
                            <span class="cmd">
                              {c.label}
                              {#if c.scope === 'editor'}<span class="scope">in editor</span>{/if}
                            </span>
                            {#if recording === c.id}
                              <button
                                type="button"
                                class="chord recording"
                                onkeydown={(e) => onRecordKeydown(e, c.id)}
                                onblur={() => (recording = null)}
                                {@attach (el) => el.focus()}
                              >
                                Press keys…
                              </button>
                            {:else}
                              <button
                                type="button"
                                class="chord"
                                class:set
                                title="Click to change"
                                onclick={() => (recording = c.id)}
                              >
                                {#each chordCaps(draft.binding(c.id)) as cap, i (i)}<kbd>{cap}</kbd>{/each}
                              </button>
                            {/if}
                            {#if set}
                              <button
                                type="button"
                                class="link reset"
                                title="Back to {chordCaps(c.def).join('+')}"
                                onclick={() => draft.unset(`keybindings.${c.id}`)}>Reset</button
                              >
                            {/if}
                            {#if clash.length > 0}
                              <span class="clash-note">
                                Also {clash.map((x) => x.label).join(', ')}
                              </span>
                            {/if}
                          </li>
                        {/each}
                      </ul>
                    </div>
                  {/if}
                {/each}
              </div>
            </section>
          {/if}
        </div>
      {/if}
    </main>
  </div>
</div>

<style>
  .page {
    position: fixed;
    inset: 0;
    z-index: 1300;
    display: flex;
    flex-direction: column;
    background: var(--bg-gradient, var(--bg));
    background-color: var(--bg);
    color: var(--text);
    font-family: var(--font-ui);
    outline: none;
  }

  /* ---- top bar ---- */
  .topbar {
    display: grid;
    grid-template-columns: 14rem minmax(0, 44rem) 1fr;
    align-items: center;
    gap: 1.5rem;
    padding: 0.85rem 1.75rem;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg-elevated) 80%, transparent);
    backdrop-filter: blur(8px);
  }
  .back {
    justify-self: start;
    display: inline-flex;
    gap: 0.45rem;
    align-items: center;
    padding: 0.4rem 0.7rem 0.4rem 0.5rem;
    border: 0;
    border-radius: var(--radius-md);
    background: none;
    color: var(--text-muted);
    font: inherit;
    cursor: pointer;
  }
  .back:hover {
    background: var(--hover);
    color: var(--text);
  }
  .search {
    position: relative;
    display: flex;
    align-items: center;
    color: var(--text-muted);
  }
  .search svg {
    position: absolute;
    left: 0.9rem;
    pointer-events: none;
  }
  .search input {
    width: 100%;
    box-sizing: border-box;
    padding: 0.7rem 1rem 0.7rem 2.6rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill, 999px);
    background: var(--bg-elevated);
    color: var(--text);
    font: inherit;
    font-size: 1rem;
  }
  .search input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-ring, var(--accent-soft));
  }
  .topbar-end {
    justify-self: end;
  }
  .unsaved-dot {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .unsaved-dot::before {
    content: '';
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--accent);
  }

  /* ---- body ---- */
  .body {
    flex: 1 1 auto;
    overflow: auto;
    display: grid;
    grid-template-columns: 14rem minmax(0, 44rem) 1fr;
    gap: 1.5rem;
    padding: 0 1.75rem;
    position: relative;
  }
  .toc {
    position: sticky;
    top: 0;
    align-self: start;
    padding-top: 2rem;
  }
  .toc h1 {
    margin: 0 0 1rem 0.6rem;
    font-size: 1.5rem;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .toc ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .toc button {
    display: block;
    width: 100%;
    padding: 0.4rem 0.6rem;
    border: 0;
    border-left: 2px solid transparent;
    background: none;
    color: var(--text-muted);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .toc button:hover {
    color: var(--text);
  }
  .toc button.active {
    border-left-color: var(--accent);
    color: var(--text);
    font-weight: 600;
  }
  .toc button.dim {
    opacity: 0.4;
  }
  .toc button.sub {
    padding-left: 1.4rem;
    font-size: 0.9rem;
  }
  .toc-note {
    margin: 1.5rem 0.6rem 0;
    color: var(--text-faint);
    font-size: 0.8rem;
    line-height: 1.45;
  }
  .toc-note code {
    font-family: var(--font-mono);
  }

  .column {
    padding: 2rem 0 14rem;
    min-width: 0;
  }
  .empty {
    padding: 4rem 0;
    color: var(--text-muted);
    text-align: center;
    font-size: 1.05rem;
  }

  .section {
    margin-bottom: 3rem;
    scroll-margin-top: 1.5rem;
  }
  .section h2 {
    margin: 0 0 1rem;
    font-size: 1.6rem;
    font-weight: 600;
    letter-spacing: -0.015em;
  }
  .section-note {
    margin: -0.5rem 0 1rem;
    color: var(--text-muted);
    font-size: 0.9rem;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    padding: 1rem 1.15rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-elevated);
    margin-bottom: 0.6rem;
  }
  .row.stacked {
    flex-direction: column;
    align-items: stretch;
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }
  .label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 550;
  }
  .desc {
    color: var(--text-muted);
    font-size: 0.88rem;
  }
  .modified {
    display: inline-flex;
    gap: 0.35rem;
    align-items: center;
    padding: 0.05rem 0.45rem;
    border-radius: var(--radius-pill, 999px);
    background: var(--bg-sunken);
    color: var(--text-muted);
    font-size: 0.72rem;
    font-weight: 500;
    letter-spacing: 0.02em;
  }
  .modified.pending {
    background: var(--accent-soft);
    color: var(--text);
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .link:disabled {
    visibility: hidden;
  }

  /* ---- mini window ---- */
  .mini {
    display: flex;
    gap: 0.3rem;
    aspect-ratio: 16 / 10;
    padding: 0.3rem;
    box-sizing: border-box;
    border: 1px solid var(--m-border);
    border-radius: var(--radius-md);
    background: var(--m-bg);
    overflow: hidden;
    position: relative;
  }
  .mini-side {
    flex: 0 0 28%;
    display: flex;
    flex-direction: column;
    gap: 0.22rem;
    padding: 0.3rem 0.25rem;
    border-radius: 0.3rem;
    background: var(--m-sunk);
  }
  .mini-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.35rem 0.4rem;
    border-radius: 0.3rem;
    background: var(--m-el);
  }
  .mini i {
    display: block;
    height: 0.22rem;
    border-radius: 1rem;
    background: var(--m-muted);
    opacity: 0.55;
  }
  .mini-side i.on {
    background: var(--m-accent);
    opacity: 1;
  }
  .mini-main b {
    display: block;
    width: 55%;
    height: 0.38rem;
    border-radius: 1rem;
    background: var(--m-text);
    margin-bottom: 0.1rem;
  }
  .mini-tag {
    display: block;
    width: 22%;
    height: 0.35rem;
    margin-top: auto;
    border-radius: 1rem;
    background: color-mix(in srgb, var(--m-accent) 25%, transparent);
    border: 1px solid var(--m-tag);
  }

  /* ---- theme mode tiles ---- */
  .modes {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.9rem;
  }
  .mode {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem;
    border: 2px solid transparent;
    border-radius: calc(var(--radius-lg) + 2px);
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .mode:hover {
    background: var(--hover);
  }
  .mode.selected {
    border-color: var(--accent);
  }
  .mode-thumb {
    display: block;
    position: relative;
  }
  .mode-thumb.split {
    aspect-ratio: 16 / 10;
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .mode-thumb.split .half {
    position: absolute;
    inset: 0;
  }
  .mode-thumb.split .half :global(.mini) {
    height: 100%;
    width: 100%;
  }
  .half.left {
    clip-path: polygon(0 0, 50% 0, 50% 100%, 0 100%);
  }
  .half.right {
    clip-path: polygon(50% 0, 100% 0, 100% 100%, 50% 100%);
  }
  .mode-name {
    font-weight: 550;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }

  /* ---- preset strip ---- */
  .strip {
    display: flex;
    gap: 0.8rem;
    overflow-x: auto;
    padding: 0.2rem 0.1rem 0.6rem;
    scroll-snap-type: x proximity;
  }
  .preset {
    flex: 0 0 9.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    padding: 0.45rem;
    border: 2px solid transparent;
    border-radius: calc(var(--radius-lg) + 2px);
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    scroll-snap-align: start;
  }
  .preset:hover {
    background: var(--hover);
  }
  .preset.selected {
    border-color: var(--accent);
  }
  .preset-name {
    display: flex;
    justify-content: space-between;
    font-size: 0.9rem;
    font-weight: 550;
  }
  .check {
    color: var(--accent);
  }
  .dots,
  .tiny-dots {
    display: flex;
    gap: 0.2rem;
  }
  .dots i,
  .tiny-dots i {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
    border: 1px solid var(--border-strong);
  }
  .tiny-dots i {
    width: 0.6rem;
    height: 0.6rem;
    margin-left: -0.3rem;
  }

  .nav-row {
    width: 100%;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .nav-row:hover {
    border-color: var(--border-strong);
    background: color-mix(in srgb, var(--bg-elevated) 85%, var(--accent-soft));
  }
  .nav-end {
    display: inline-flex;
    align-items: center;
    gap: 0.75rem;
    color: var(--accent);
    font-weight: 550;
    white-space: nowrap;
  }

  /* ---- fonts ---- */
  .font-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    row-gap: 0.8rem;
  }
  .font-controls {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    align-items: stretch;
    width: 16rem;
  }
  .font-controls input[type='text'],
  .hex {
    box-sizing: border-box;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    font: inherit;
  }
  .font-controls input:focus,
  .hex:focus {
    outline: 2px solid var(--accent-ring, var(--accent-soft));
    outline-offset: -1px;
  }
  .size {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .size input {
    flex: 1;
    accent-color: var(--accent);
  }
  .size output {
    min-width: 3.4rem;
    color: var(--text-muted);
    font-size: 0.85rem;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .specimen {
    grid-column: 1 / -1;
    margin: 0;
    padding: 0.9rem 1rem;
    border-radius: var(--radius-md);
    background: var(--bg-sunken);
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---- layout toggles ---- */
  .toggles {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0 0.6rem;
  }
  .toggle-row {
    cursor: pointer;
  }
  .switch {
    appearance: none;
    flex: none;
    position: relative;
    width: 2.4rem;
    height: 1.35rem;
    margin: 0;
    border-radius: 999px;
    background: var(--border-strong);
    cursor: pointer;
    transition: background 0.15s;
  }
  .switch::after {
    content: '';
    position: absolute;
    top: 0.15rem;
    left: 0.15rem;
    width: 1.05rem;
    height: 1.05rem;
    border-radius: 50%;
    background: var(--bg-elevated);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
    transition: transform 0.15s;
  }
  .switch:checked {
    background: var(--accent);
  }
  .switch:checked::after {
    transform: translateX(1.05rem);
  }
  .switch:focus-visible {
    outline: 2px solid var(--accent-ring, var(--accent-soft));
    outline-offset: 2px;
  }
  .segmented {
    display: inline-flex;
    padding: 0.2rem;
    border-radius: var(--radius-md);
    background: var(--bg-sunken);
  }
  .segmented button {
    padding: 0.35rem 0.9rem;
    border: 0;
    border-radius: calc(var(--radius-md) - 2px);
    background: none;
    color: var(--text-muted);
    font: inherit;
    cursor: pointer;
  }
  .segmented button.selected {
    background: var(--bg-elevated);
    color: var(--text);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  }

  /* ---- keyboard ---- */
  .cheats {
    columns: 2;
    column-gap: 0.8rem;
  }
  .cheat-card {
    break-inside: avoid;
    margin-bottom: 0.8rem;
    padding: 0.9rem 1rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-elevated);
  }
  .cheat-card h3 {
    margin: 0 0 0.5rem;
    color: var(--text-muted);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .cheat-card ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .cheat-card li {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0;
    border-top: 1px solid var(--border);
  }
  .cheat-card li:first-child {
    border-top: 0;
  }
  .cmd {
    font-size: 0.9rem;
  }
  .scope {
    margin-left: 0.3rem;
    color: var(--text-faint);
    font-size: 0.72rem;
  }
  .chord {
    display: inline-flex;
    gap: 0.2rem;
    padding: 0.15rem;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .chord:hover {
    border-color: var(--border-strong);
  }
  .chord.set kbd {
    border-color: var(--accent);
    color: var(--accent);
  }
  .chord.recording {
    padding: 0.2rem 0.6rem;
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--text);
    font-size: 0.8rem;
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      box-shadow: 0 0 0 3px var(--accent-soft);
    }
  }
  kbd {
    min-width: 1.1rem;
    padding: 0.08rem 0.35rem;
    border: 1px solid var(--border-strong);
    border-bottom-width: 2px;
    border-radius: 0.3rem;
    background: var(--bg);
    font-family: var(--font-ui);
    font-size: 0.75rem;
    text-align: center;
  }
  .cheat-card li .reset {
    font-size: 0.72rem;
  }
  li.clash .cmd {
    color: var(--danger);
  }
  .clash-note {
    grid-column: 1 / -1;
    margin-top: -0.15rem;
    color: var(--danger);
    font-size: 0.75rem;
  }

  /* ---- colours subpage ---- */
  .crumbs {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    color: var(--text-muted);
    font-size: 0.9rem;
  }
  .crumbs .link {
    font-size: inherit;
  }
  .sub-title {
    margin: 0.4rem 0 0.3rem;
    font-size: 1.6rem;
    font-weight: 600;
    letter-spacing: -0.015em;
  }
  .lede {
    margin: 0 0 1.5rem;
    color: var(--text-muted);
  }
  .schemes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }
  .scheme {
    padding: 0.9rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-elevated);
  }
  .scheme.current {
    border-color: var(--border-strong);
  }
  .scheme header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 0.6rem;
  }
  .scheme h3 {
    margin: 0;
    font-size: 1.05rem;
  }
  .now {
    color: var(--accent);
    font-size: 0.75rem;
    font-weight: 600;
  }
  .swatches {
    list-style: none;
    margin: 0.9rem 0 0;
    padding: 0;
  }
  .swatches li {
    display: grid;
    grid-template-columns: auto 1fr 6.5rem 2.6rem;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0;
  }
  .swatches li.set .sw-label {
    font-weight: 600;
  }
  .swatches li.set .sw-label::after {
    content: ' •';
    color: var(--accent);
  }
  .swatch {
    width: 1.6rem;
    height: 1.6rem;
    border: 1px solid var(--border-strong);
    border-radius: 0.45rem;
    cursor: pointer;
    overflow: hidden;
  }
  .swatch input {
    opacity: 0;
    width: 100%;
    height: 100%;
    cursor: pointer;
  }
  .sw-label {
    font-size: 0.88rem;
  }
  .hex {
    width: 100%;
    padding: 0.25rem 0.45rem;
    font-family: var(--font-mono);
    font-size: 0.78rem;
  }

  @media (max-width: 64rem) {
    .topbar,
    .body {
      grid-template-columns: 11rem minmax(0, 1fr);
    }
    .topbar-end {
      display: none;
    }
    .schemes,
    .toggles {
      grid-template-columns: 1fr;
    }
    .cheats {
      columns: 1;
    }
  }
</style>
