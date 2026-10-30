<script lang="ts">
  // PROTOTYPE — Variant C: settings as a searchable palette. Throwaway.
  //
  // Keyboard-first, in the shape of QuickNav: ONE flat, fuzzy-filtered list of
  // every setting with its current value. ↑/↓ move, Enter (or →) drills into a
  // row's inline editor; booleans toggle in place. Escape peels one level.
  import { fuzzyMatch } from '$lib/fuzzy';
  import { theme } from '$lib/state/theme.svelte';
  import { draft } from './draft.svelte';
  import {
    chordCaps,
    chordFromEvent,
    COLOR_KEYS,
    COLOR_LABELS,
    COMMANDS,
    conflicts,
    DEFAULT_PRESET,
    EDITOR_MODES,
    effectivePalette,
    FONT_ROLE_LABELS,
    FONT_ROLES,
    FONT_SUGGESTIONS,
    getPath,
    PANEL_DEFAULTS,
    PRESETS,
    presetById,
    THEME_MODES,
    type Command,
    type FontRole,
    type Json,
  } from './model';
  import type { BaseColor } from '$lib/state/themeColors';

  interface Props {
    onclose: () => void;
  }
  let { onclose }: Props = $props();

  type Scheme = 'light' | 'dark';
  type Option = { id: string; label: string };
  type Kind =
    | { t: 'choice'; path: string; options: readonly Option[]; def: string }
    | { t: 'bool'; path: string; def: boolean }
    | { t: 'preset' }
    | { t: 'color'; scheme: Scheme; key: BaseColor }
    | { t: 'font'; role: FontRole }
    | { t: 'panels' }
    | { t: 'shortcut'; cmd: Command };

  interface Row {
    id: string;
    cat: string;
    label: string;
    value: string;
    /** config.json sets this (after the draft's edits). */
    set: boolean;
    /** The draft edits this. */
    edited: boolean;
    kind: Kind;
    swatch?: string;
    caps?: string[];
  }

  // ------------------------------------------------------------- values

  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  /**
   * Write `value` for `path`. Choosing what config.json already holds drops the
   * edit; choosing the built-in default removes the key; anything else sets it.
   */
  function choose(path: string, value: Json, def: Json) {
    const orig = getPath(draft.original, path);
    if (orig !== undefined && eq(value, orig)) draft.set(path, value);
    else if (eq(value, def)) draft.unset(path);
    else draft.set(path, value);
  }

  const str = (path: string, def: string) => {
    const v = draft.get(path);
    return typeof v === 'string' ? v : def;
  };
  const bool = (path: string, def: boolean) => {
    const v = draft.get(path);
    return typeof v === 'boolean' ? v : def;
  };
  function fontSize(role: FontRole): number | null {
    const s = FONT_ROLE_LABELS[role].size;
    if (!s) return null;
    const v = draft.get(`fonts.${role}.size`);
    return typeof v === 'number' ? v : s.def;
  }
  const fontFamily = (role: FontRole) => str(`fonts.${role}.family`, FONT_ROLE_LABELS[role].defaultFamily);
  const fontSet = (role: FontRole) => draft.isSet(`fonts.${role}.family`) || draft.isSet(`fonts.${role}.size`);
  const fontEdited = (role: FontRole) =>
    draft.isEdited(`fonts.${role}.family`) || draft.isEdited(`fonts.${role}.size`);
  const panelsSet = () => PANEL_DEFAULTS.some((p) => draft.isSet(`defaults.${p.key}`));
  const panelsEdited = () => PANEL_DEFAULTS.some((p) => draft.isEdited(`defaults.${p.key}`));

  const scheme = $derived<Scheme>(theme.resolved);

  // ------------------------------------------------------------- rows

  const rows = $derived.by((): Row[] => {
    void draft.config;
    const out: Row[] = [];
    const modeKind: Kind = { t: 'choice', path: 'theme', options: THEME_MODES, def: 'system' };
    out.push({
      id: 'theme',
      cat: 'Appearance',
      label: 'Theme mode',
      value: THEME_MODES.find((m) => m.id === str('theme', 'system'))?.label ?? 'System',
      set: draft.isSet('theme'),
      edited: draft.isEdited('theme'),
      kind: modeKind,
    });
    out.push({
      id: 'colorTheme',
      cat: 'Appearance',
      label: 'Color theme',
      value: presetById(draft.get('colorTheme') ?? DEFAULT_PRESET).name,
      set: draft.isSet('colorTheme'),
      edited: draft.isEdited('colorTheme'),
      kind: { t: 'preset' },
      swatch: effectivePalette(draft.config, scheme).accent,
    });
    for (const role of FONT_ROLES) {
      const size = fontSize(role);
      const unit = FONT_ROLE_LABELS[role].size?.unit ?? '';
      out.push({
        id: `font:${role}`,
        cat: 'Fonts',
        label: `${FONT_ROLE_LABELS[role].label} font`,
        value: size === null ? fontFamily(role) : `${fontFamily(role)} · ${size}${unit}`,
        set: fontSet(role),
        edited: fontEdited(role),
        kind: { t: 'font', role },
      });
    }
    const openNames = PANEL_DEFAULTS.filter((p) => p.key !== 'titles' && bool(`defaults.${p.key}`, p.def)).map(
      (p) => p.label,
    );
    out.push({
      id: 'panels',
      cat: 'Panels',
      label: 'Panels open by default',
      value: openNames.join(', ') || 'None',
      set: panelsSet(),
      edited: panelsEdited(),
      kind: { t: 'panels' },
    });
    out.push({
      id: 'editorMode',
      cat: 'Panels',
      label: 'New tiles open in',
      value: EDITOR_MODES.find((m) => m.id === str('defaults.editorMode', 'read'))?.label ?? 'Read',
      set: draft.isSet('defaults.editorMode'),
      edited: draft.isEdited('defaults.editorMode'),
      kind: { t: 'choice', path: 'defaults.editorMode', options: EDITOR_MODES, def: 'read' },
    });
    for (const p of PANEL_DEFAULTS) {
      const path = `defaults.${p.key}`;
      out.push({
        id: path,
        cat: 'Panels',
        label: p.key === 'titles' ? p.label : `Open by default · ${p.label}`,
        value: bool(path, p.def) ? 'On' : 'Off',
        set: draft.isSet(path),
        edited: draft.isEdited(path),
        kind: { t: 'bool', path, def: p.def },
      });
    }
    for (const s of ['light', 'dark'] as const) {
      const pal = effectivePalette(draft.config, s);
      for (const key of COLOR_KEYS) {
        const path = `colors.${s}.${key}`;
        out.push({
          id: path,
          cat: 'Colors',
          label: `${COLOR_LABELS[key]} (${s})`,
          value: pal[key],
          set: draft.isSet(path),
          edited: draft.isEdited(path),
          kind: { t: 'color', scheme: s, key },
          swatch: pal[key],
        });
      }
    }
    for (const cmd of COMMANDS) {
      const path = `keybindings.${cmd.id}`;
      const chord = draft.binding(cmd.id);
      out.push({
        id: path,
        cat: 'Shortcuts',
        label: `Shortcut · ${cmd.label}`,
        value: chord,
        set: draft.isSet(path),
        edited: draft.isEdited(path),
        kind: { t: 'shortcut', cmd },
        caps: chordCaps(chord),
      });
    }
    return out;
  });

  let query = $state('');
  let sel = $state(0);

  const filtered = $derived.by((): Row[] => {
    const q = query.trim();
    if (q === '') return rows;
    const scored: { row: Row; score: number }[] = [];
    for (const row of rows) {
      const m = fuzzyMatch(q, `${row.label} ${row.cat} ${row.value}`);
      if (m) scored.push({ row, score: m.score });
    }
    return scored.sort((a, b) => b.score - a.score).map((s) => s.row);
  });

  const selIndex = $derived(Math.min(sel, Math.max(0, filtered.length - 1)));

  // ------------------------------------------------------------- drill state

  let openId = $state<string | null>(null);
  const current = $derived(openId === null ? null : (rows.find((r) => r.id === openId) ?? null));

  /** Selection inside a list-style level (choice, preset, panels). */
  let sub = $state(0);
  /** colorTheme as it was when the preset level opened (Escape restores it). */
  let presetEntry = $state<Json | undefined>(undefined);
  /** Shortcut capture: the chord pressed but not yet confirmed. */
  let pending = $state<string | null>(null);
  /** Font family field text and the highlighted suggestion (-1: none). */
  let famText = $state('');
  let famSel = $state(-1);

  let input = $state<HTMLInputElement | null>(null);
  let panel = $state<HTMLDivElement | null>(null);
  let list = $state<HTMLUListElement | null>(null);
  let levelEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    queueMicrotask(() => input?.focus());
  });

  $effect(() => {
    void selIndex;
    void sub;
    void openId;
    queueMicrotask(() => {
      list?.querySelector<HTMLElement>('.row.selected')?.scrollIntoView({ block: 'nearest' });
      levelEl?.querySelector<HTMLElement>('.opt.selected')?.scrollIntoView({ block: 'nearest' });
    });
  });

  function listLength(row: Row): number {
    const k = row.kind;
    if (k.t === 'choice') return k.options.length;
    if (k.t === 'preset') return PRESETS.length;
    if (k.t === 'panels') return PANEL_DEFAULTS.length;
    return 0;
  }

  function drill(row: Row) {
    const k = row.kind;
    if (k.t === 'bool') {
      toggle(k.path, k.def);
      return;
    }
    // Park focus on the panel before the level swap removes the focused node,
    // so its focusout doesn't land mid-render.
    panel?.focus();
    openId = row.id;
    pending = null;
    if (k.t === 'choice') sub = Math.max(0, k.options.findIndex((o) => o.id === str(k.path, k.def)));
    else if (k.t === 'preset') {
      presetEntry = draft.get('colorTheme');
      sub = Math.max(0, PRESETS.findIndex((p) => p.id === (presetEntry ?? DEFAULT_PRESET)));
    } else if (k.t === 'panels') sub = 0;
    else if (k.t === 'font') {
      famText = draft.isSet(`fonts.${k.role}.family`) ? fontFamily(k.role) : '';
      famSel = -1;
    }
    queueMicrotask(() => {
      const target = levelEl?.querySelector<HTMLElement>('[data-autofocus]') ?? levelEl;
      target?.focus();
    });
  }

  function back(revert: boolean) {
    const row = current;
    if (row?.kind.t === 'preset' && revert) restorePreset();
    panel?.focus();
    openId = null;
    pending = null;
    queueMicrotask(() => input?.focus());
  }

  function toggle(path: string, def: boolean) {
    choose(path, !bool(path, def), def);
  }

  function previewPreset(i: number) {
    sub = i;
    const id = PRESETS[i].id;
    const orig = getPath(draft.original, 'colorTheme');
    if (orig !== undefined && orig === id) draft.set('colorTheme', id);
    else if (id === DEFAULT_PRESET) draft.unset('colorTheme');
    else draft.set('colorTheme', id);
  }

  function restorePreset() {
    if (presetEntry === undefined) draft.unset('colorTheme');
    else draft.set('colorTheme', presetEntry);
  }

  /** Remove everything a row writes. Fonts reset family and size only, never `files`. */
  function reset(row: Row) {
    const k = row.kind;
    if (k.t === 'choice' || k.t === 'bool') draft.unset(k.path);
    else if (k.t === 'preset') {
      draft.unset('colorTheme');
      presetEntry = undefined;
      sub = 0;
    } else if (k.t === 'color') draft.unset(`colors.${k.scheme}.${k.key}`);
    else if (k.t === 'font') {
      draft.unset(`fonts.${k.role}.family`);
      draft.unset(`fonts.${k.role}.size`);
      famText = '';
    } else if (k.t === 'panels') for (const p of PANEL_DEFAULTS) draft.unset(`defaults.${p.key}`);
    else if (k.t === 'shortcut') {
      draft.unset(`keybindings.${k.cmd.id}`);
      pending = null;
    }
  }

  // ------------------------------------------------------------- keys

  function stop(e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function onKeydown(e: KeyboardEvent) {
    if (current === null) return rootKey(e);
    const k = current.kind;
    if (k.t === 'shortcut') return captureKey(e, k.cmd);
    if (e.key === 'Escape') {
      stop(e);
      back(true);
      return;
    }
    if (k.t === 'choice' || k.t === 'preset' || k.t === 'panels') listKey(e, current);
    else if (k.t === 'font') fontKey(e, k.role);
  }

  function rootKey(e: KeyboardEvent) {
    const n = filtered.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      stop(e);
      if (n === 0) return;
      sel = (selIndex + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    } else if (e.key === 'Enter') {
      stop(e);
      const row = filtered[selIndex];
      if (row) drill(row);
    } else if (e.key === 'ArrowRight' && input && input.selectionStart === query.length) {
      const row = filtered[selIndex];
      if (row) {
        stop(e);
        drill(row);
      }
    } else if (e.key === 'Escape' && query !== '') {
      stop(e);
      query = '';
      sel = 0;
    }
  }

  function listKey(e: KeyboardEvent, row: Row) {
    const k = row.kind;
    const n = listLength(row);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      stop(e);
      const i = (sub + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      if (k.t === 'preset') previewPreset(i);
      else sub = i;
    } else if (e.key === 'ArrowLeft') {
      stop(e);
      back(true);
    } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
      stop(e);
      commitOption(row, sub);
    }
  }

  function commitOption(row: Row, i: number) {
    const k = row.kind;
    sub = i;
    if (k.t === 'choice') {
      choose(k.path, k.options[i].id, k.def);
      back(false);
    } else if (k.t === 'preset') {
      previewPreset(i);
      back(false);
    } else if (k.t === 'panels') {
      const p = PANEL_DEFAULTS[i];
      toggle(`defaults.${p.key}`, p.def);
    }
  }

  const suggestions = $derived(
    FONT_SUGGESTIONS.filter((f) => f.toLowerCase().includes(famText.trim().toLowerCase())).slice(0, 8),
  );

  function setFamily(role: FontRole, family: string) {
    famText = family;
    const v = family.trim();
    if (v === '') draft.unset(`fonts.${role}.family`);
    else draft.set(`fonts.${role}.family`, v);
  }

  function stepSize(role: FontRole, dir: 1 | -1) {
    const s = FONT_ROLE_LABELS[role].size;
    const cur = fontSize(role);
    if (!s || cur === null) return;
    const next = Math.round(Math.min(s.max, Math.max(s.min, cur + dir * s.step)) * 1000) / 1000;
    choose(`fonts.${role}.size`, next, s.def);
  }

  function fontKey(e: KeyboardEvent, role: FontRole) {
    const t = e.target as HTMLElement;
    if (t.dataset.field === 'family') {
      const n = suggestions.length;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n > 0) {
        stop(e);
        famSel = famSel < 0 ? (e.key === 'ArrowDown' ? 0 : n - 1) : (famSel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      } else if (e.key === 'Enter') {
        stop(e);
        if (famSel >= 0 && suggestions[famSel]) setFamily(role, suggestions[famSel]);
        famSel = -1;
        levelEl?.querySelector<HTMLElement>('[data-field="size"]')?.focus();
      }
    } else if (t.dataset.field === 'size') {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        stop(e);
        stepSize(role, e.key === 'ArrowUp' ? 1 : -1);
      } else if (e.key === 'Enter') {
        stop(e);
        back(false);
      }
    }
  }

  function captureKey(e: KeyboardEvent, cmd: Command) {
    stop(e);
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    if (plain && e.key === 'Escape') return back(false);
    if (plain && e.key === 'Enter') {
      if (pending !== null) draft.setBinding(cmd.id, pending);
      return back(false);
    }
    if (plain && e.key === 'Backspace') {
      draft.unset(`keybindings.${cmd.id}`);
      pending = null;
      return;
    }
    const chord = chordFromEvent(e);
    if (chord !== null) pending = chord;
  }

  const clashes = $derived.by(() => {
    if (current?.kind.t !== 'shortcut') return [];
    const id = current.kind.cmd.id;
    return conflicts(pending ?? draft.binding(id), id, (x) => draft.binding(x));
  });

  const hexOk = (v: string) => /^#[0-9a-f]{6}$/i.test(v);
  function setColor(s: Scheme, key: BaseColor, v: string) {
    if (CSS.supports('color', v)) draft.set(`colors.${s}.${key}`, v);
  }
</script>

<div class="pc-backdrop" role="presentation" onclick={onclose}></div>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="pc-panel"
  role="dialog"
  aria-label="Settings"
  tabindex="-1"
  data-own-arrows
  data-testid="settings-palette"
  bind:this={panel}
  onkeydown={onKeydown}
>
  {#if current === null}
    <div class="pc-search">
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4" />
        <line x1="10.4" y1="10.4" x2="14" y2="14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      </svg>
      <input
        bind:this={input}
        bind:value={query}
        oninput={() => (sel = 0)}
        class="pc-input"
        type="text"
        placeholder="Search settings…"
        spellcheck="false"
        aria-label="Search settings"
      />
      <span class="pc-count">{filtered.length}</span>
    </div>

    <ul class="pc-list" bind:this={list} role="listbox" aria-label="Settings">
      {#each filtered as row, i (row.id)}
        <li role="option" aria-selected={i === selIndex}>
          <div
            class="row"
            class:selected={i === selIndex}
            role="button"
            tabindex="-1"
            onclick={() => {
              sel = i;
              drill(row);
              if (row.kind.t === 'bool') input?.focus();
            }}
            onkeydown={() => {}}
            onmousemove={() => (sel = i)}
          >
            <span class="dot" class:set={row.set} class:edited={row.edited} title={row.edited ? 'Changed in this session' : row.set ? 'Set in config.json' : 'Default'}></span>
            <span class="label">{row.label}</span>
            <span class="chip">{row.cat}</span>
            <span class="value">
              {#if row.swatch}<span class="sw" style:background={row.swatch}></span>{/if}
              {#if row.caps}
                {#each row.caps as cap, ci (ci)}<kbd>{cap}</kbd>{/each}
              {:else if row.kind.t === 'bool'}
                <span class="switch" class:on={row.value === 'On'}></span>
              {:else}
                <span class="vtext">{row.value}</span>
              {/if}
            </span>
            {#if row.set}
              <button
                type="button"
                class="row-reset"
                title="Reset to default"
                aria-label="Reset {row.label}"
                onclick={(e) => {
                  e.stopPropagation();
                  reset(row);
                  input?.focus();
                }}>↺</button
              >
            {/if}
          </div>
        </li>
      {:else}
        <li class="pc-empty">No setting matches “{query}”.</li>
      {/each}
    </ul>
  {:else}
    {@const row = current}
    {@const k = row.kind}
    <div class="crumb">
      <button type="button" class="crumb-back" onclick={() => back(true)} aria-label="Back">‹</button>
      <span class="crumb-root">Settings</span>
      <span class="crumb-sep">›</span>
      <span class="crumb-here">{row.label}</span>
      {#if row.set}
        <button type="button" class="reset" onclick={() => reset(row)}>↺ Reset</button>
      {/if}
    </div>

    <div class="level" bind:this={levelEl} tabindex="-1">
      {#if k.t === 'choice'}
        <ul class="opts" role="listbox" aria-label={row.label}>
          {#each k.options as o, i (o.id)}
            {@const active = str(k.path, k.def) === o.id}
            <li role="option" aria-selected={i === sub}>
              <button type="button" class="opt" class:selected={i === sub} onclick={() => commitOption(row, i)} onmousemove={() => (sub = i)}>
                <span class="radio" class:on={active}></span>
                <span>{o.label}</span>
                {#if o.id === k.def}<span class="muted">default</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      {:else if k.t === 'preset'}
        <ul class="opts" role="listbox" aria-label="Color theme">
          {#each PRESETS as p, i (p.id)}
            {@const pal = p[scheme]}
            <li role="option" aria-selected={i === sub}>
              <button type="button" class="opt preset" class:selected={i === sub} onclick={() => commitOption(row, i)} onmousemove={() => { if (sub !== i) previewPreset(i); }}>
                <span class="radio" class:on={(presetEntry ?? DEFAULT_PRESET) === p.id}></span>
                <span class="pname">{p.name}</span>
                <span class="strip" style:background={pal.bg} style:border-color={pal.borderStrong}>
                  <span style:background={pal.bgElevated}></span>
                  <span style:background={pal.text}></span>
                  <span style:background={pal.textMuted}></span>
                  <span style:background={pal.accent}></span>
                  <span style:background={pal.tagText}></span>
                  <span style:background={pal.danger}></span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
        <p class="note">Moving the selection previews the theme. Enter keeps it, Esc goes back to {presetById(presetEntry ?? DEFAULT_PRESET).name}. Per-colour overrides under Colors still win.</p>
      {:else if k.t === 'panels'}
        <ul class="opts" role="listbox" aria-label="Panels open by default">
          {#each PANEL_DEFAULTS as p, i (p.key)}
            {@const on = bool(`defaults.${p.key}`, p.def)}
            <li role="option" aria-selected={i === sub}>
              <button type="button" class="opt" class:selected={i === sub} onclick={() => commitOption(row, i)} onmousemove={() => (sub = i)}>
                <span class="check" class:on>{on ? '✓' : ''}</span>
                <span>{p.label}</span>
                {#if draft.isSet(`defaults.${p.key}`)}<span class="dot set inline"></span>{/if}
              </button>
            </li>
          {/each}
        </ul>
        <p class="note">For Bundles opened for the first time; a Bundle you've opened keeps its own layout.</p>
      {:else if k.t === 'color'}
        {@const value = effectivePalette(draft.config, k.scheme)[k.key]}
        <div class="color">
          <label class="big-sw" style:background={value}>
            <input
              type="color"
              value={hexOk(value) ? value : '#000000'}
              oninput={(e) => setColor(k.scheme, k.key, e.currentTarget.value)}
              aria-label="Pick {row.label}"
            />
          </label>
          <div class="color-fields">
            <input
              class="field mono"
              type="text"
              data-autofocus
              spellcheck="false"
              value={value}
              onchange={(e) => setColor(k.scheme, k.key, e.currentTarget.value.trim())}
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  stop(e);
                  setColor(k.scheme, k.key, e.currentTarget.value.trim());
                  back(false);
                }
              }}
              aria-label="{row.label} value"
            />
            <span class="muted">
              {draft.isSet(`colors.${k.scheme}.${k.key}`) ? 'Overrides' : 'From'} the {presetById(draft.get('colorTheme') ?? DEFAULT_PRESET).name} theme · any CSS colour
            </span>
          </div>
        </div>
      {:else if k.t === 'font'}
        {@const meta = FONT_ROLE_LABELS[k.role]}
        {@const size = fontSize(k.role)}
        <div class="font">
          <label class="flabel" for="pc-family">Family</label>
          <input
            id="pc-family"
            class="field"
            type="text"
            data-field="family"
            data-autofocus
            spellcheck="false"
            placeholder={meta.defaultFamily}
            value={famText}
            oninput={(e) => {
              setFamily(k.role, e.currentTarget.value);
              famSel = -1;
            }}
          />
          <ul class="sugg" role="listbox" aria-label="Font suggestions">
            {#each suggestions as f, i (f)}
              <li role="option" aria-selected={i === famSel}>
                <button type="button" class="opt" class:selected={i === famSel} style:font-family={f} onclick={() => setFamily(k.role, f)}>{f}</button>
              </li>
            {/each}
          </ul>
          {#if meta.size && size !== null}
            <label class="flabel" for="pc-size">Size</label>
            <div class="stepper">
              <button type="button" onclick={() => stepSize(k.role, -1)} aria-label="Smaller">−</button>
              <input id="pc-size" class="field mono" type="text" data-field="size" readonly value="{size}{meta.size.unit}" />
              <button type="button" onclick={() => stepSize(k.role, 1)} aria-label="Larger">+</button>
            </div>
          {/if}
          <p class="note">{meta.hint}. <span style:font-family={draft.isSet(`fonts.${k.role}.family`) ? fontFamily(k.role) : undefined}>The quick brown fox jumps over the lazy dog.</span></p>
        </div>
      {:else if k.t === 'shortcut'}
        <div class="capture" data-autofocus tabindex="-1" aria-label="Press the new shortcut">
          <span class="muted">{pending === null ? 'Press the new shortcut…' : 'New shortcut'}</span>
          <span class="keys big">
            {#each chordCaps(pending ?? draft.binding(k.cmd.id)) as cap, ci (ci)}<kbd>{cap}</kbd>{/each}
          </span>
          {#if pending === null}
            <span class="muted">Current · default {chordCaps(k.cmd.def).join(' ')}</span>
          {/if}
        </div>
        {#if clashes.length > 0}
          <p class="clash">⚠ Also bound to {clashes.map((c) => `${c.label} (${c.scope})`).join(', ')}.</p>
        {/if}
      {/if}
    </div>
  {/if}

  <footer class="pc-foot">
    {#if current === null}
      <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
      <span><kbd>↵</kbd> open / toggle</span>
      <span><kbd>esc</kbd> {query ? 'clear' : 'close'}</span>
      <span class="legend"><span class="dot set inline"></span> set in config.json</span>
    {:else if current.kind.t === 'shortcut'}
      <span><kbd>↵</kbd> confirm</span>
      <span><kbd>⌫</kbd> reset to default</span>
      <span><kbd>esc</kbd> cancel</span>
    {:else if current.kind.t === 'font'}
      <span><kbd>↑</kbd><kbd>↓</kbd> pick / resize</span>
      <span><kbd>tab</kbd> next field</span>
      <span><kbd>esc</kbd> back</span>
    {:else if current.kind.t === 'color'}
      <span><kbd>↵</kbd> apply</span>
      <span><kbd>esc</kbd> back</span>
    {:else}
      <span><kbd>↑</kbd><kbd>↓</kbd> {current.kind.t === 'preset' ? 'preview' : 'move'}</span>
      <span><kbd>↵</kbd> {current.kind.t === 'panels' ? 'toggle' : 'choose'}</span>
      <span><kbd>esc</kbd> back</span>
    {/if}
  </footer>
</div>

<style>
  .pc-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1300;
    background: rgba(16, 22, 18, 0.4);
  }

  .pc-panel {
    position: fixed;
    z-index: 1301;
    top: 12%;
    left: 50%;
    transform: translateX(-50%);
    box-sizing: border-box;
    width: min(42rem, 92vw);
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
    box-shadow: var(--shadow-lg);
    font-family: var(--font-ui);
    overflow: hidden;
  }
  .pc-panel:focus {
    outline: none;
  }

  .pc-search {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.7rem 0.9rem;
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
  }
  .pc-input {
    flex: 1 1 auto;
    min-width: 0;
    border: none;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 1.05rem;
  }
  .pc-input:focus {
    outline: none;
  }
  .pc-count {
    font-size: 0.75rem;
    color: var(--text-faint);
  }

  .pc-list,
  .opts,
  .sugg {
    list-style: none;
    margin: 0;
    padding: 0.35rem;
    overflow: auto;
  }
  .pc-list {
    flex: 1 1 auto;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.42rem 0.6rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 0.9rem;
  }
  .row.selected {
    background: var(--accent-soft);
  }
  .label {
    flex: 0 1 auto;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip {
    flex: none;
    font-size: 0.66rem;
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-pill);
    background: var(--bg-sunken);
    color: var(--text-muted);
    letter-spacing: 0.02em;
  }
  .value {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.3rem;
    min-width: 0;
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .vtext {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 16rem;
  }

  .dot {
    flex: none;
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 50%;
    border: 1px solid transparent;
  }
  .dot.set {
    background: var(--accent);
  }
  .dot.edited {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  .dot.inline {
    display: inline-block;
    vertical-align: middle;
  }

  .row-reset {
    flex: none;
    width: 1.5rem;
    height: 1.5rem;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    visibility: hidden;
  }
  .row:hover .row-reset,
  .row.selected .row-reset {
    visibility: visible;
  }
  .row-reset:hover {
    background: var(--hover);
    color: var(--text);
  }

  .sw {
    width: 0.85rem;
    height: 0.85rem;
    border-radius: 0.2rem;
    border: 1px solid var(--border-strong);
  }

  .switch {
    position: relative;
    width: 1.8rem;
    height: 1rem;
    border-radius: var(--radius-pill);
    background: var(--border-strong);
    transition: background 0.12s;
  }
  .switch::after {
    content: '';
    position: absolute;
    top: 0.125rem;
    left: 0.125rem;
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 50%;
    background: var(--bg-elevated);
    transition: transform 0.12s;
  }
  .switch.on {
    background: var(--accent);
  }
  .switch.on::after {
    transform: translateX(0.8rem);
  }

  kbd {
    display: inline-block;
    min-width: 1.1rem;
    padding: 0.05rem 0.3rem;
    border: 1px solid var(--border-strong);
    border-bottom-width: 2px;
    border-radius: 0.3rem;
    background: var(--bg);
    color: var(--text);
    font: 0.72rem/1.3 var(--font-ui);
    text-align: center;
  }

  .pc-empty {
    padding: 0.8rem 0.6rem;
    color: var(--text-muted);
    font-size: 0.88rem;
  }

  /* -------- drilled level */
  .crumb {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.6rem 0.8rem;
    border-bottom: 1px solid var(--border);
    font-size: 0.92rem;
  }
  .crumb-back {
    width: 1.6rem;
    height: 1.6rem;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-muted);
    font-size: 1.2rem;
    line-height: 1;
    cursor: pointer;
  }
  .crumb-back:hover {
    background: var(--hover);
  }
  .crumb-root {
    color: var(--text-muted);
  }
  .crumb-sep {
    color: var(--text-faint);
  }
  .crumb-here {
    font-weight: 600;
  }
  .reset {
    margin-left: auto;
    padding: 0.2rem 0.55rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: none;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .reset:hover {
    color: var(--text);
    background: var(--hover);
  }

  .level {
    flex: 1 1 auto;
    overflow: auto;
    padding: 0.35rem 0.35rem 0.6rem;
  }
  .level:focus {
    outline: none;
  }

  .opt {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    padding: 0.45rem 0.6rem;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 0.9rem;
    text-align: left;
    cursor: pointer;
  }
  .opt.selected {
    background: var(--accent-soft);
  }
  .muted {
    color: var(--text-muted);
    font-size: 0.8rem;
  }
  .opt .muted {
    margin-left: auto;
  }

  .radio {
    flex: none;
    width: 0.8rem;
    height: 0.8rem;
    border-radius: 50%;
    border: 1.5px solid var(--border-strong);
  }
  .radio.on {
    border-color: var(--accent);
    background: radial-gradient(var(--accent) 45%, transparent 50%);
  }
  .check {
    flex: none;
    width: 1rem;
    height: 1rem;
    border-radius: 0.25rem;
    border: 1.5px solid var(--border-strong);
    display: grid;
    place-items: center;
    font-size: 0.7rem;
    color: var(--accent-contrast);
  }
  .check.on {
    background: var(--accent);
    border-color: var(--accent);
  }

  .preset .pname {
    width: 8rem;
  }
  .strip {
    margin-left: auto;
    display: flex;
    gap: 0.2rem;
    padding: 0.25rem;
    border: 1px solid;
    border-radius: var(--radius-sm);
  }
  .strip span {
    width: 1.1rem;
    height: 0.9rem;
    border-radius: 0.2rem;
  }

  .note {
    margin: 0.5rem 0.6rem 0;
    color: var(--text-muted);
    font-size: 0.8rem;
    line-height: 1.45;
  }

  .field {
    box-sizing: border-box;
    width: 100%;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    font: inherit;
  }
  .field:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .mono {
    font-family: var(--font-mono);
  }

  .color {
    display: flex;
    gap: 1rem;
    align-items: center;
    padding: 0.8rem 0.6rem;
  }
  .big-sw {
    flex: none;
    width: 4rem;
    height: 4rem;
    border-radius: var(--radius-md);
    border: 1px solid var(--border-strong);
    cursor: pointer;
    position: relative;
  }
  .big-sw input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
  .color-fields {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .font {
    padding: 0.5rem 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .flabel {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-faint);
    margin-top: 0.3rem;
  }
  .sugg {
    padding: 0;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.1rem;
  }
  .stepper {
    display: flex;
    gap: 0.35rem;
    width: 11rem;
  }
  .stepper .field {
    text-align: center;
  }
  .stepper button {
    flex: none;
    width: 2.2rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    cursor: pointer;
  }
  .stepper button:hover {
    background: var(--hover);
  }

  .capture {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.6rem;
    margin: 0.6rem;
    padding: 1.6rem 1rem;
    border: 1.5px dashed var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--bg-sunken);
  }
  .capture:focus {
    outline: none;
    border-color: var(--accent);
  }
  .keys.big {
    display: flex;
    gap: 0.35rem;
  }
  .keys.big kbd {
    font-size: 1.1rem;
    padding: 0.25rem 0.6rem;
  }
  .clash {
    margin: 0 0.6rem;
    padding: 0.45rem 0.6rem;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--danger);
    font-size: 0.83rem;
  }

  .pc-foot {
    display: flex;
    gap: 1rem;
    padding: 0.45rem 0.9rem;
    border-top: 1px solid var(--border);
    background: var(--bg-sunken);
    color: var(--text-muted);
    font-size: 0.75rem;
  }
  .pc-foot span {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  .pc-foot kbd {
    font-size: 0.66rem;
    padding: 0 0.25rem;
  }
  .legend {
    margin-left: auto;
  }
</style>
