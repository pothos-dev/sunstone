<script lang="ts">
  /**
   * A small floating context menu (slice: tree-crud). Positioned at (x, y),
   * renders a list of actions, and closes on outside-click / Escape / action.
   * Generic over the action id so the caller decides the items.
   */
  import { menuIconSvg, type MenuIconName } from '$lib/menuIcons';

  interface MenuItem {
    id: string;
    label: string;
    /** Visually separate from the previous item (e.g. before a destructive op). */
    separated?: boolean;
    danger?: boolean;
    /** Leading glyph; items without one keep the slot so labels stay aligned. */
    icon?: MenuIconName;
  }

  interface Props {
    x: number;
    y: number;
    items: MenuItem[];
    onselect: (id: string) => void;
    onclose: () => void;
  }

  let { x, y, items, onselect, onclose }: Props = $props();

  function choose(id: string) {
    onselect(id);
    onclose();
  }
  // Escape-to-close is owned by the global capture-phase peel (App.svelte →
  // focus.escape), which cancels this overlay via the focus store's overlay
  // stack and restores focus to the opener Region. No local Escape handler here.
</script>

<!-- Backdrop: an outside click closes the menu. -->
<div
  class="backdrop"
  role="presentation"
  onclick={onclose}
  oncontextmenu={(e) => {
    e.preventDefault();
    onclose();
  }}
></div>

<div
  class="menu"
  role="menu"
  data-testid="context-menu"
  style="left: {x}px; top: {y}px"
>
  {#each items as item (item.id)}
    <button
      type="button"
      role="menuitem"
      class="item"
      class:separated={item.separated}
      class:danger={item.danger}
      data-action={item.id}
      onclick={() => choose(item.id)}
    >
      <span class="icon">
        {#if item.icon}{@html menuIconSvg(item.icon)}{/if}
      </span>
      {item.label}
    </button>
  {/each}
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
  }

  .menu {
    position: fixed;
    z-index: 1001;
    min-width: 160px;
    padding: 0.25rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
    color: var(--text);
    box-shadow: var(--shadow-md);
    font-family: var(--font-ui);
    font-size: 0.85rem;
  }

  .item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.35rem 0.6rem;
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: background 0.12s ease;
  }

  .icon {
    display: inline-flex;
    flex: none;
    width: 14px;
    height: 14px;
    opacity: 0.8;
  }

  .item:hover {
    background: var(--hover);
  }

  .item:focus-visible {
    background: var(--hover);
  }

  .item.separated {
    margin-top: 0.25rem;
    border-top: 1px solid var(--border);
    padding-top: 0.4rem;
  }

  .item.danger {
    color: var(--danger);
  }

  .item.danger:hover,
  .item.danger:focus-visible {
    background: var(--danger);
    color: var(--danger-contrast);
  }
</style>
