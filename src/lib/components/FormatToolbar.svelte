<script lang="ts">
  import type { FormatState } from '$lib/editor/formatState';
  import {
    controlTitle,
    HEADING_LEVELS,
    headingTitle,
    headingValue,
    INLINE_CONTROLS,
    linkLabel,
    rovingIndex,
    type InlineControlId,
  } from '$lib/editor/formatToolbar';
  import { menuIconSvg } from '$lib/menuIcons';

  // The formatting Toolbar (aa-1): the second row of the Concept header, shown
  // only while the Tile is editing. A thin renderer over `editor/formatToolbar.ts`
  // — it owns no transform and no editor: every control calls back into Tile,
  // which runs the existing command from `editor/commands.ts` and refocuses the
  // editor.
  //
  // Keyboard: ONE Tab stop (roving tabindex, WAI-ARIA toolbar pattern);
  // Left/Right/Home/End move between controls, Escape hands focus back to the
  // editor text. Buttons prevent mousedown so a click never takes focus — or
  // the selection — away from the editor.

  interface Props {
    /** The formats active at the editor's selection (pressed states). */
    formatState: FormatState;
    /** Run an inline toggle (bold, italic, strikethrough, inline code). */
    onInline: (id: InlineControlId) => void;
    /** Set the heading level of the selected lines (0 = paragraph). */
    onHeading: (level: number) => void;
    /** Insert a link, or select the URL of the one under the caret. */
    onLink: () => void;
    /** Escape: return focus to the editor text. */
    onEscape: () => void;
  }

  let { formatState, onInline, onHeading, onLink, onEscape }: Props = $props();

  // CodeMirror's `Mod` is Cmd on macOS; the tooltips say what the user presses.
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  let toolbar = $state<HTMLDivElement | null>(null);
  // The control holding the Toolbar's single Tab stop.
  let current = $state(0);

  function controls(): HTMLElement[] {
    return toolbar ? Array.from(toolbar.querySelectorAll<HTMLElement>('[data-roving]')) : [];
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      onEscape();
      return;
    }
    const items = controls();
    const at = items.indexOf(e.target as HTMLElement);
    if (at === -1) return;
    const next = rovingIndex(at, e.key, items.length);
    if (next === null) return;
    e.preventDefault();
    current = next;
    items[next].focus();
  }

  /** Focus the Toolbar's current control (Alt+F10 from the editor). */
  export function focus(): void {
    controls()[current]?.focus();
  }

  const noFocusSteal = (e: MouseEvent) => e.preventDefault();
</script>

<!-- svelte-ignore a11y_interactive_supports_focus -->
<div
  class="format-toolbar"
  role="toolbar"
  aria-label="Formatting"
  data-testid="format-toolbar"
  tabindex="-1"
  bind:this={toolbar}
  onkeydown={onKeydown}
>
  <select
    class="heading-select"
    data-roving
    data-testid="format-heading"
    aria-label="Heading level"
    title={headingTitle(mac)}
    tabindex={current === 0 ? 0 : -1}
    value={headingValue(formatState)}
    onfocus={() => (current = 0)}
    onchange={(e) => {
      const select = e.currentTarget as HTMLSelectElement;
      if (select.value !== '') onHeading(Number(select.value));
      // Snap back to the readout: when the command changed the lines, the new
      // state re-renders the value; when it was a no-op (blank lines only), the
      // picker must not claim a level the document does not have.
      select.value = headingValue(formatState);
    }}
  >
    {#if formatState.heading === null}
      <option value="" disabled>Mixed</option>
    {/if}
    {#each HEADING_LEVELS as h (h.level)}
      <option value={String(h.level)}>{h.label}</option>
    {/each}
  </select>

  {#each INLINE_CONTROLS as c, i (c.id)}
    <button
      type="button"
      class="fmt-btn"
      class:active={formatState[c.id]}
      data-roving
      data-testid={`format-${c.id}`}
      aria-label={c.label}
      aria-pressed={formatState[c.id]}
      title={controlTitle(c.label, c.key, mac)}
      tabindex={current === i + 1 ? 0 : -1}
      onfocus={() => (current = i + 1)}
      onmousedown={noFocusSteal}
      onclick={() => onInline(c.id)}
    >
      {@html menuIconSvg(c.id, 14)}
    </button>
  {/each}

  <button
    type="button"
    class="fmt-btn"
    class:active={formatState.link}
    data-roving
    data-testid="format-link"
    aria-label={linkLabel(formatState)}
    aria-pressed={formatState.link}
    title={controlTitle(linkLabel(formatState), null, mac)}
    tabindex={current === INLINE_CONTROLS.length + 1 ? 0 : -1}
    onfocus={() => (current = INLINE_CONTROLS.length + 1)}
    onmousedown={noFocusSteal}
    onclick={onLink}
  >
    {@html menuIconSvg('link', 14)}
  </button>
</div>

<style>
  /* Its own row of the Concept header: `flex-basis: 100%` breaks it onto a new
     line of the header's wrapping flex row, under the title/controls. Its own
     controls wrap again in a narrow Tile instead of overflowing. */
  .format-toolbar {
    flex: 1 0 100%;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.2rem;
    min-width: 0;
  }

  .format-toolbar:focus {
    outline: none;
  }

  .heading-select {
    height: 1.6rem;
    max-width: 8rem;
    padding: 0 0.3rem;
    margin-right: 0.3rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    color: inherit;
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
  }

  .fmt-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.6rem;
    height: 1.6rem;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
    cursor: pointer;
    transition: background 0.12s ease;
  }

  .fmt-btn:hover {
    background: var(--hover);
  }

  .fmt-btn.active {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }

  .fmt-btn:focus-visible,
  .heading-select:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
