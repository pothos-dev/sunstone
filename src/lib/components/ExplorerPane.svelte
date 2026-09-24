<script lang="ts">
  // The Explorer Section's body in the desktop shell: the Bundle tree, its root
  // drop zone and "+ New…" button, plus the Explorer's keyboard wiring —
  // tree navigation, CRUD keys (routed to the shared TreeCrud dialogs App
  // renders), the post-CRUD refocus, and the Focused-item → DOM focus mirror.
  // App reaches in only through the exported `reveal` / `focusInitial` and the
  // TreeCrud commit/cancel hooks.
  import type TreeCrud from './TreeCrud.svelte';
  import Tree from './Tree.svelte';
  import type { TreeNode } from '$lib/types';
  import { bundle } from '$lib/state/bundle.svelte';
  import { session } from '$lib/state/session.svelte';
  import { treeActions } from '$lib/state/treeActions.svelte';
  import { treeDnd } from '$lib/state/treeDnd.svelte';
  import { focus } from '$lib/state/focus.svelte';
  import { explorerNav } from '$lib/state/explorerNav.svelte';
  import { flattenVisible, neighborAfterRemoval, ordinaryChildren } from '$lib/treeNav';
  import { retryFrames } from '$lib/retryFrames';
  import { foldersToExpand } from '$lib/tileTitle';

  interface Props {
    /** The TreeCrud dialogs/menu App renders (null until mounted). */
    crud: ReturnType<typeof TreeCrud> | null;
    /** The active Tile's Concept path (row highlight). */
    selected: string | null;
    /** Open a Concept (row click). */
    onopen: (path: string) => void;
    /** Open a Concept from the keyboard, landing focus in the Editor. */
    onopenFocus: (path: string) => void;
  }

  let { crud, selected, onopen, onopenFocus }: Props = $props();

  let treePane = $state<HTMLDivElement | null>(null);

  // The Explorer row element for `path` (Tree.svelte stamps `data-row-path`).
  function treeRow(host: ParentNode | null, path: string): HTMLElement | null {
    return host?.querySelector<HTMLElement>(`.row[data-row-path="${CSS.escape(path)}"]`) ?? null;
  }

  function openMenu(node: TreeNode, x: number, y: number) {
    crud?.openMenu(node, x, y);
  }

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
        pendingDeleteNeighbor = neighborAfterRemoval(rows, p);
        crud?.requestDelete(p);
      },
      newConcept: (p) => crud?.requestNewConcept(p),
      newFolder: (p) => crud?.requestNewFolder(p),
      move: (p) => crud?.requestMove(p),
    });
    if (crudHandled) e.preventDefault();
  }

  let pendingDeleteNeighbor = $state<string | null>(null);

  /**
   * Show `folder` in the Explorer (Tile header breadcrumbs): expand it and every
   * ancestor, reveal the Explorer if hidden, and move the Explorer cursor onto
   * its row, scrolled into view. Focus stays where it is (the Tile).
   */
  export function reveal(folder: string) {
    for (const p of foldersToExpand(folder)) {
      if (!session.isExpanded(p)) session.setExpanded(p, true);
    }
    session.revealLeftSection('explorer');
    explorerNav.setFocused(folder);
    retryFrames(() => {
      const row = treeRow(treePane, folder);
      if (!row) return false;
      row.scrollIntoView({ block: 'nearest' });
      return true;
    }, 10);
  }

  function refocusAt(path: string | null) {
    if (path !== null) explorerNav.setFocused(path);
    retryFrames(() => {
      const target = explorerNav.focusedPath;
      if (target === null || !treePane) return true;
      const row = treeRow(treePane, target);
      if (!row) return false;
      row.focus();
      return true;
    }, 10);
  }

  /** On launch: focus the first Explorer row unless something already holds focus. */
  export function focusInitial() {
    retryFrames(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return true;
      const root = bundle.tree;
      if (treePane && root) {
        const rows = flattenVisible(root, (q) => session.isExpanded(q));
        const first = rows[0]?.path;
        if (first !== undefined) {
          explorerNav.setFocused(first);
          const row = treeRow(treePane, first);
          if (row) {
            row.focus();
            return true;
          }
        }
      }
      return false;
    }, 20);
  }

  /** TreeCrud committed: refocus the touched row (or a deleted row's neighbour). */
  export function onCrudCommit(path: string, opts?: { deleted?: boolean }) {
    if (opts?.deleted) {
      refocusAt(pendingDeleteNeighbor);
      pendingDeleteNeighbor = null;
    } else {
      refocusAt(path);
    }
  }

  /** TreeCrud cancelled: return focus to the Explorer's Focused item. */
  export function onCrudCancel() {
    refocusAt(explorerNav.focusedPath);
    pendingDeleteNeighbor = null;
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
  ondragover={(e) => {
    const from = treeDnd.dragging;
    if (from === null || !treeDnd.canDrop(from, '')) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    treeDnd.dropTarget = '';
  }}
  ondragleave={(e) => {
    if (
      e.currentTarget instanceof Node &&
      e.relatedTarget instanceof Node &&
      e.currentTarget.contains(e.relatedTarget)
    )
      return;
    if (treeDnd.dropTarget === '') treeDnd.dropTarget = null;
  }}
  ondrop={(e) => {
    e.preventDefault();
    const from = treeDnd.dragging;
    treeDnd.end();
    if (from !== null && treeDnd.canDrop(from, '')) void treeActions.movePath(from, '');
  }}
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
