<script lang="ts">
  // The Explorer Section's body in the desktop shell: the Bundle tree, its root
  // drop zone and "+ New…" button, plus the Explorer's keyboard wiring —
  // tree navigation, CRUD keys (routed to the shared TreeCrud dialogs App
  // renders) and the Focused-item → DOM focus mirror.
  //
  // The pane is mounted only while the Explorer Section is expanded
  // (SidebarSection unmounts collapsed content), so the STATE side of reveal /
  // refocus (expanding folders, re-opening the Section, moving the Explorer
  // cursor) stays in App, which then drives the DOM side lazily through the
  // exported `scrollToRow` / `focusRow` / `focusFirstRow` once the pane exists.
  import type TreeCrud from './TreeCrud.svelte';
  import Tree from './Tree.svelte';
  import type { TreeNode } from '$lib/types';
  import { bundle } from '$lib/state/bundle.svelte';
  import { session } from '$lib/state/session.svelte';
  import { treeActions } from '$lib/state/treeActions.svelte';
  import { treeDnd } from '$lib/state/treeDnd.svelte';
  import { dropZoneHandlers } from '$lib/treeDnd';
  import { focus } from '$lib/state/focus.svelte';
  import { explorerNav } from '$lib/state/explorerNav.svelte';
  import { flattenVisible, neighborAfterRemoval, ordinaryChildren } from '$lib/treeNav';

  interface Props {
    /** The TreeCrud dialogs/menu App renders (null until mounted). */
    crud: ReturnType<typeof TreeCrud> | null;
    /** The active Tile's Concept path (row highlight). */
    selected: string | null;
    /** Open a Concept (row click). */
    onopen: (path: string) => void;
    /** Open a Concept from the keyboard, landing focus in the Editor. */
    onopenFocus: (path: string) => void;
    /**
     * A keyboard Delete is about to open TreeCrud's confirm for a row; `neighbor`
     * is the row that should take the cursor if the delete commits.
     */
    ondeleterequest: (neighbor: string | null) => void;
  }

  let { crud, selected, onopen, onopenFocus, ondeleterequest }: Props = $props();

  let treePane = $state<HTMLDivElement | null>(null);

  // The Explorer row element for `path` (Tree.svelte stamps `data-row-path`).
  function treeRow(host: ParentNode | null, path: string): HTMLElement | null {
    return host?.querySelector<HTMLElement>(`.row[data-row-path="${CSS.escape(path)}"]`) ?? null;
  }

  function openMenu(node: TreeNode, x: number, y: number) {
    crud?.openMenu(node, x, y);
  }

  // The pane itself is the Bundle-root drop zone (rows handle their folders).
  const rootDrop = dropZoneHandlers({
    state: treeDnd,
    dir: () => '',
    move: (from, toDir) => void treeActions.movePath(from, toDir),
  });

  const rootOrdinary = $derived(bundle.tree ? ordinaryChildren(bundle.tree) : []);

  function onTreeKeydown(e: KeyboardEvent) {
    const handled = explorerNav.handleKeydown(e, bundle.tree, {
      isExpanded: (p) => session.isExpanded(p),
      setExpanded: (p, open) => session.setExpanded(p, open),
      openConcept: onopenFocus,
    });
    if (handled) {
      e.preventDefault();
      return;
    }
    if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select')) {
      return;
    }
    const crudHandled = explorerNav.handleCrudKeydown(e, {
      rename: (p) => crud?.requestRename(p),
      remove: (p) => {
        const rows = flattenVisible(bundle.tree, (q) => session.isExpanded(q));
        ondeleterequest(neighborAfterRemoval(rows, p));
        crud?.requestDelete(p);
      },
      newConcept: (p) => crud?.requestNewConcept(p),
      newFolder: (p) => crud?.requestNewFolder(p),
      move: (p) => crud?.requestMove(p),
    });
    if (crudHandled) e.preventDefault();
  }

  /** Scroll `path`'s row into view; false while it is not rendered yet. */
  export function scrollToRow(path: string): boolean {
    const row = treeRow(treePane, path);
    if (!row) return false;
    row.scrollIntoView({ block: 'nearest' });
    return true;
  }

  /** Focus `path`'s row; false while it is not rendered yet. */
  export function focusRow(path: string): boolean {
    const row = treeRow(treePane, path);
    if (!row) return false;
    row.focus();
    return true;
  }

  /**
   * Make the first visible row the Focused item and focus it; false while the
   * tree (or that row) is not rendered yet.
   */
  export function focusFirstRow(): boolean {
    const root = bundle.tree;
    if (!treePane || !root) return false;
    const first = flattenVisible(root, (q) => session.isExpanded(q))[0]?.path;
    if (first === undefined) return false;
    explorerNav.setFocused(first);
    return focusRow(first);
  }

  // Mirror the Explorer Focused-item path into DOM focus while it holds focus.
  $effect(() => {
    const path = explorerNav.focusedPath;
    if (path === null || !treePane) return;
    if (focus.focusedRegion !== 'explorer') return;
    const row = treeRow(treePane, path);
    if (row && document.activeElement !== row) row.focus();
  });
</script>

<div
  class="tree-tile"
  class:drop-target={treeDnd.dropTarget === ''}
  bind:this={treePane}
  onkeydown={onTreeKeydown}
  ondragover={rootDrop.ondragover}
  ondragleave={rootDrop.ondragleave}
  ondrop={rootDrop.ondrop}
  role="presentation"
>
  {#if bundle.loading}
    <p class="status">Loading…</p>
  {:else if bundle.error}
    <p class="status error">{bundle.error}</p>
  {:else if bundle.tree}
    <div
      class="tree-root"
      data-testid="tree"
      oncontextmenu={(e) => {
        if (e.target === e.currentTarget && bundle.tree) {
          e.preventDefault();
          openMenu(bundle.tree, e.clientX, e.clientY);
        }
      }}
      role="tree"
      tabindex="-1"
    >
      {#each rootOrdinary as child (child.path)}
        <Tree node={child} {selected} {onopen} onmenu={openMenu} />
      {/each}
    </div>
    <button
      type="button"
      class="root-new"
      data-testid="root-new-concept"
      onclick={() => bundle.tree && openMenu(bundle.tree, 16, 80)}
    >+ New…</button>
  {/if}
  {#if treeActions.error}
    <p class="status error" data-testid="tree-error">{treeActions.error}</p>
  {/if}
</div>

<style>
  .tree-tile {
    padding: 0.5rem;
    font-size: 14px;
  }

  .tree-tile:focus {
    outline: none;
  }

  .tree-tile.drop-target {
    box-shadow: inset 0 0 0 1px var(--accent-ring);
    border-radius: var(--radius-sm);
  }

  .status {
    padding: 1rem;
    color: var(--text-muted);
  }

  .status.error {
    color: var(--danger);
  }

  .root-new {
    margin: 0.3rem 0.1rem;
    padding: 0.25rem 0.6rem;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
    opacity: 0.8;
    transition: background 0.12s ease;
  }

  .root-new:hover {
    background: var(--hover);
    opacity: 1;
  }
</style>
