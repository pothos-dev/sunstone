<script lang="ts">
  // The Concept metadata pill next to the title in the Tile header (ov-24):
  // `[shield Reviewed | book 3 | clock stale]`, each segment only when its data
  // exists. Hovering it for half a second (or focusing it from the keyboard)
  // opens one popover with the detail — Trust, Lifecycle, Sources — which stays
  // open while the pointer is over the pill or the popover and closes on leave
  // and on Escape (through the overlay stack). What to show is
  // `$lib/metaPill`; the hover timing is `$lib/hoverIntent`. Relative times
  // follow the minute `clock`.
  import { clock } from '$lib/state/clock.svelte';
  import { useOverlay } from '$lib/state/overlay.svelte';
  import { metaPillView, type ConceptMeta, type StampRow } from '$lib/metaPill';
  import { createHoverIntent } from '$lib/hoverIntent';
  import { actorView } from '$lib/actor';
  import { menuIconSvg } from '$lib/menuIcons';
  import type { FrontmatterTime } from '$lib/frontmatterTime';

  interface Props {
    /** The open Concept's metadata; `null` (or nothing to show) renders no pill. */
    meta: ConceptMeta | null;
    /** Jump to the Concept's Sources section ("view ↓"); omitted, no link. */
    onViewSources?: () => void;
  }

  let { meta, onViewSources }: Props = $props();

  const view = $derived(meta ? metaPillView(meta, clock.now) : null);

  const POPOVER_WIDTH = 330;
  const MARGIN = 8;

  let open = $state(false);
  let pillEl = $state<HTMLElement | null>(null);
  let popoverEl = $state<HTMLElement | null>(null);
  let pos = $state({ left: 0, top: 0 });

  // Fixed-positioned under the pill so no Tile or scroller clips it.
  function place() {
    if (!pillEl) return;
    const r = pillEl.getBoundingClientRect();
    const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - POPOVER_WIDTH - MARGIN));
    pos = { left, top: r.bottom + 6 };
  }

  const intent = createHoverIntent({
    openDelay: 500,
    closeDelay: 150,
    setOpen: (v) => {
      if (v) place();
      open = v;
    },
  });

  useOverlay(
    () => open,
    () => intent.close(),
  );

  // Surfaces without the App's Escape peel (the anonymous web reader) close it
  // here; under the App both paths close the same flag, which is harmless.
  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') intent.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // The Concept changed to one without metadata: nothing to keep open.
  $effect(() => {
    if (!view && open) intent.close();
  });

  function onFocus(e: FocusEvent) {
    if ((e.currentTarget as HTMLElement).matches(':focus-visible')) intent.focus();
  }

  function onBlur(e: FocusEvent) {
    const to = e.relatedTarget as Node | null;
    if (to && popoverEl?.contains(to)) return;
    if (open) intent.close();
  }

  function viewSources() {
    intent.close();
    onViewSources?.();
  }

  const icon = (name: 'shield' | 'book' | 'log') => menuIconSvg(name, 12);
</script>

{#snippet actor(raw: string | null)}
  {#if raw}
    {@const v = actorView(raw)}
    <span class="actor actor-{v.kind}" title={v.title}
      >{#if v.kindLabel}<span class="actor-kind">{v.kindLabel}</span>{/if}<span class="actor-id">{v.text}</span
      >{#if v.version}<span class="actor-version">{v.version}</span>{/if}</span
    >
  {:else}
    <span class="mp-missing">unknown</span>
  {/if}
{/snippet}

{#snippet when(at: string | null, time: FrontmatterTime | null)}
  {#if time}
    <time class="fm-time" datetime={time.datetime} title={time.title}>{time.text}</time>
  {:else if at}
    <span class="mp-at">{at}</span>
  {/if}
{/snippet}

{#snippet stamp(label: string, row: StampRow, showActor: boolean)}
  <div class="mp-row" data-testid="meta-popover-stamp">
    <span class="mp-label">{label}</span>
    {#if showActor}{@render actor(row.actor)}{/if}
    {@render when(row.at, row.time)}
  </div>
{/snippet}

{#if view}
  <span class="meta-pill-anchor">
    <button
      type="button"
      class="meta-pill"
      data-testid="meta-pill"
      aria-label="Concept metadata"
      aria-haspopup="dialog"
      aria-expanded={open}
      bind:this={pillEl}
      onmouseenter={() => intent.enter()}
      onmouseleave={() => intent.leave()}
      onfocus={onFocus}
      onblur={onBlur}
      onclick={() => (open ? intent.close() : intent.focus())}
    >
      {#if view.trust}
        <span
          class="seg"
          class:accent={view.trust.accent}
          data-testid="meta-pill-trust"
          data-tier={view.trust.tier}
          title={view.trust.hint}>{@html icon('shield')}{view.trust.label}</span
        >
      {/if}
      {#if view.sources !== null}
        <span
          class="seg"
          data-testid="meta-pill-sources"
          title={`${view.sources} ${view.sources === 1 ? 'source' : 'sources'}`}>{@html icon('book')}{view.sources}</span
        >
      {/if}
      {#if view.lifecycle}
        <span class="seg" class:danger={view.lifecycle.danger} data-testid="meta-pill-lifecycle"
          >{@html icon('log')}{view.lifecycle.label}</span
        >
      {/if}
    </button>

    {#if open}
      {@const p = view.popover}
      <div
        class="meta-popover"
        role="dialog"
        aria-label="Concept metadata"
        data-testid="meta-popover"
        tabindex="-1"
        bind:this={popoverEl}
        style="left: {pos.left}px; top: {pos.top}px; width: {POPOVER_WIDTH}px"
        onmouseenter={() => intent.enter()}
        onmouseleave={() => intent.leave()}
      >
        {#if p.trust}
          <section class="mp-section" data-testid="meta-popover-trust">
            <h3>Trust</h3>
            {#if p.trust.tier}
              <div class="mp-row">
                <span class="mp-tier tier-{p.trust.tier.tier}" title={p.trust.tier.hint}>{p.trust.tier.label}</span>
              </div>
            {/if}
            {#if p.trust.generated}
              {@render stamp(p.trust.legacy ? 'Generated (timestamp)' : 'Generated', p.trust.generated, !p.trust.legacy)}
            {/if}
            {#each p.trust.verified as row, i (i)}
              {@render stamp('Verified', row, true)}
            {/each}
          </section>
        {/if}
        {#if p.lifecycle && (p.lifecycle.status || p.lifecycle.staleAfter)}
          <section class="mp-section" data-testid="meta-popover-lifecycle">
            <h3>Lifecycle</h3>
            {#if p.lifecycle.status}
              <div class="mp-row">
                <span class="mp-label">Status</span>
                <span class="mp-status" title={p.lifecycle.meaning}>{p.lifecycle.status}</span>
              </div>
            {/if}
            {#if p.lifecycle.staleAfter}
              <div class="mp-row" class:mp-danger={p.lifecycle.stale}>
                <span class="mp-label">{p.lifecycle.stale ? 'Stale since' : 'Stale after'}</span>
                {@render when(p.lifecycle.staleAfter.at, p.lifecycle.staleAfter.time)}
              </div>
            {/if}
          </section>
        {/if}
        {#if p.sources > 0}
          <section class="mp-section" data-testid="meta-popover-sources">
            <h3>Sources</h3>
            <div class="mp-row">
              <span>{p.sources} {p.sources === 1 ? 'source' : 'sources'}</span>
              {#if onViewSources}
                <button type="button" class="mp-link" data-testid="meta-view-sources" onclick={viewSources}
                  >view ↓</button
                >
              {/if}
            </div>
          </section>
        {/if}
      </div>
    {/if}
  </span>
{/if}

<style>
  .meta-pill-anchor {
    display: inline-flex;
    flex: none;
    margin-left: 6px;
  }

  .meta-pill {
    display: inline-flex;
    align-items: stretch;
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    background: none;
    color: var(--text-muted);
    font-family: var(--font-ui);
    font-size: 11.5px;
    line-height: 1;
    cursor: default;
    overflow: hidden;
  }

  .meta-pill:hover,
  .meta-pill[aria-expanded='true'] {
    background: var(--hover);
  }

  .meta-pill:focus-visible {
    outline: 2px solid var(--accent-ring, var(--accent));
    outline-offset: 1px;
  }

  .seg {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 7px;
    white-space: nowrap;
    font-weight: 500;
  }

  .seg + .seg {
    border-left: 1px solid var(--border-strong);
  }

  .seg :global(svg) {
    flex: none;
  }

  .seg.accent {
    color: var(--accent);
  }

  .seg.danger {
    color: var(--danger);
  }

  .meta-popover {
    position: fixed;
    z-index: 1200;
    box-sizing: border-box;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-elevated);
    box-shadow: var(--shadow-lg);
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 12.5px;
    line-height: 1.5;
    cursor: default;
  }

  .mp-section + .mp-section {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }

  h3 {
    margin: 0 0 4px;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  .mp-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 8px;
    min-width: 0;
  }

  .mp-label {
    color: var(--text-muted);
  }

  .mp-tier {
    padding: 0 7px;
    border-radius: var(--radius-pill);
    font-weight: 600;
    background: var(--bg-sunken);
    color: var(--text-muted);
  }

  .mp-tier.tier-machineConfirmed {
    color: var(--text);
  }

  .mp-tier.tier-humanReviewed {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .mp-status {
    font-weight: 600;
  }

  .mp-danger,
  .mp-danger .mp-label,
  .mp-missing {
    color: var(--danger);
  }

  .mp-missing {
    font-style: italic;
  }

  .mp-link {
    padding: 0;
    border: none;
    background: none;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
  }

  .mp-link:hover {
    text-decoration: underline;
  }
</style>
