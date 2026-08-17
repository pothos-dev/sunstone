<script lang="ts">
  /**
   * Tree CRUD feature (slice: tree-crud): the right-click context menu over
   * tree nodes plus the create / rename / move / delete confirmation dialogs.
   * Extracted out of App.svelte; the actual filesystem mutations live in the
   * `treeActions` store, which this component drives.
   *
   * Cross-feature coupling — `focusTypeForPath`: a freshly-created (non-reserved)
   * Concept should open with the Properties panel focused on its `type` field
   * (OKF validity), while a reserved file (index.md / log.md) is exempt and must
   * NOT focus-the-type. App owns the `focusTypeForPath` $state (plain navigation
   * also clears it); this component writes through the `$bindable` prop:
   * confirm-create-concept SETS it to the new path, create-reserved CLEARS it to
   * null. The set/clear stays end-to-end correct because the binding mutates
   * App's own state directly.
   */
  import type { TreeNode } from '$lib/types';
  import { dirname, ensureMd, isMarkdownName, joinPath } from '$lib/path';
  import { isReservedFile, reservedPath, type ReservedKind } from '$lib/reserved';
  import {
    childDirOf,
    folderPaths,
    menuItemsFor,
    nodeAt as nodeAtIn,
    renameSeed,
  } from '$lib/treeCrud';
  import { bundle } from '$lib/state/bundle.svelte';
  import { treeActions } from '$lib/state/treeActions.svelte';
  import { focus } from '$lib/state/focus.svelte';
  import ContextMenu from '$lib/components/ContextMenu.svelte';

  interface Props {
    /** App-owned focus-the-type request; bound so create-concept SETs it and
        create-reserved CLEARs it (see component header). */
    focusTypeForPath: string | null;
    /**
     * Fired when a dialog COMMITS (slice: explorer-crud-keybindings), so the
     * Explorer can return its Focused item to the affected row. `path` is the
     * renamed/created/moved node's NEW path; for a delete it is the deleted
     * node's path with `deleted: true` (App resolves a neighbour). Not fired
     * when a create/rename is a no-op (empty / unchanged name) — that closes
     * like a cancel. Optional: the context menu uses the same dialogs and simply
     * leaves it unset.
     */
    oncommit?: (path: string, opts?: { deleted?: boolean }) => void;
    /** Fired when a dialog is CANCELLED, so the Explorer can restore focus. */
    oncancel?: () => void;
  }

  let { focusTypeForPath = $bindable(), oncommit, oncancel }: Props = $props();

  // `viaKeyboard` records whether the dialog was opened by a Focused-item
  // keybinding (slice: explorer-crud-keybindings) rather than the context menu.
  // Only keyboard-opened dialogs fire `oncommit`/`oncancel` (which return focus
  // to the Explorer); context-menu dialogs keep their existing behaviour (e.g.
  // a new Concept lands focused on its `type` field, not back on the tree row).
  type Dialog = { viaKeyboard: boolean } & (
    | { kind: 'newConcept' | 'newFolder' | 'rename'; node: TreeNode; value: string }
    | { kind: 'move'; node: TreeNode; value: string }
    | { kind: 'delete'; node: TreeNode }
  );

  // The open context menu (right-click / per-row ⋯), or null.
  let menu = $state<{ node: TreeNode; x: number; y: number } | null>(null);
  // The open modal dialog (name prompt / move picker / delete confirm), or null.
  let dialog = $state<Dialog | null>(null);

  // Overlay-stack registration (slice: escape-peel-restore-opener): the context
  // menu and the CRUD dialogs are OVERLAYS, so the global Escape peel closes them
  // as one layer (the dialogs gained Escape-to-close here, where before only
  // Cancel/backdrop closed them). We register on open / unregister on close,
  // capturing the opener Region at open time. CANCEL (Escape/backdrop) restores
  // focus to the opener; for a KEYBOARD-opened dialog `closeDialog`/`confirmDialog`
  // ALSO route focus through `oncancel`/`oncommit` to the Explorer's affected row
  // (slice: explorer-crud-keybindings) — both target the Explorer, so the
  // opener-restore is consistent, never fighting the slice-3 routing.
  let menuOverlayId: number | null = null;
  $effect(() => {
    if (menu && menuOverlayId === null) {
      menuOverlayId = focus.pushOverlay(() => (menu = null));
    } else if (!menu && menuOverlayId !== null) {
      focus.removeOverlay(menuOverlayId);
      menuOverlayId = null;
    }
  });
  let dialogOverlayId: number | null = null;
  $effect(() => {
    if (dialog && dialogOverlayId === null) {
      // Cancel closes the dialog via the SAME path as the Cancel button so the
      // keyboard-CRUD focus restore (oncancel) still fires.
      dialogOverlayId = focus.pushOverlay(closeDialog);
    } else if (!dialog && dialogOverlayId !== null) {
      focus.removeOverlay(dialogOverlayId);
      dialogOverlayId = null;
    }
  });

  // Move-picker targets: all folder paths in the live tree ('' = Bundle root).
  // Falls back to a root-only tree while the Bundle is still loading.
  const moveTargets = $derived(
    folderPaths(bundle.tree ?? { name: '', path: '', isDir: true, children: [] }),
  );

  /** Open the context menu at viewport (x, y), targeting `node`. */
  export function openMenu(node: TreeNode, x: number, y: number) {
    menu = { node, x, y };
  }

  /** Find the tree node at bundle-relative `path` in the live tree. */
  function nodeAt(path: string): TreeNode | null {
    return nodeAtIn(bundle.tree, path);
  }

  // Keyboard CRUD entry points (slice: explorer-crud-keybindings): fire the SAME
  // dialogs the context menu opens, targeting the Explorer's Focused item (by
  // path). They resolve the node from the live tree so the dialog state matches
  // exactly what a right-click would produce; the new-target rule is the shared
  // `childDirOf`. No-op when the path is gone (tree changed underfoot).
  export function requestRename(path: string) {
    const node = nodeAt(path);
    if (node) dialog = { kind: 'rename', node, value: renameSeed(node), viaKeyboard: true };
  }
  export function requestDelete(path: string) {
    const node = nodeAt(path);
    if (node) dialog = { kind: 'delete', node, viaKeyboard: true };
  }
  export function requestNewConcept(path: string) {
    const node = nodeAt(path);
    if (node) dialog = { kind: 'newConcept', node, value: '', viaKeyboard: true };
  }
  export function requestNewFolder(path: string) {
    const node = nodeAt(path);
    if (node) dialog = { kind: 'newFolder', node, value: '', viaKeyboard: true };
  }
  export function requestMove(path: string) {
    const node = nodeAt(path);
    if (node) dialog = { kind: 'move', node, value: dirname(node.path), viaKeyboard: true };
  }

  const menuItems = $derived(menu ? menuItemsFor(menu.node) : []);

  function onMenuSelect(id: string) {
    const node = menu?.node;
    if (!node) return;
    if (id === 'newConcept') dialog = { kind: 'newConcept', node, value: '', viaKeyboard: false };
    else if (id === 'newFolder') dialog = { kind: 'newFolder', node, value: '', viaKeyboard: false };
    else if (id.startsWith('createReserved:')) {
      const kind = id.slice('createReserved:'.length) as ReservedKind;
      const path = reservedPath(node.path, kind);
      focusTypeForPath = null; // reserved files have no `type` to focus.
      void treeActions.createReservedFile(node.path, kind, path);
    } else if (id === 'rename')
      dialog = { kind: 'rename', node, value: renameSeed(node), viaKeyboard: false };
    else if (id === 'move') dialog = { kind: 'move', node, value: dirname(node.path), viaKeyboard: false };
    else if (id === 'delete') dialog = { kind: 'delete', node, viaKeyboard: false };
  }

  /**
   * Cancel path: close the dialog and (only for a keyboard-opened dialog) let
   * the Explorer restore its Focused item. A context-menu dialog leaves focus
   * untouched, preserving the prior mouse-driven behaviour.
   */
  function closeDialog() {
    const viaKeyboard = dialog?.viaKeyboard ?? false;
    dialog = null;
    if (viaKeyboard) oncancel?.();
  }

  async function confirmDialog() {
    if (!dialog) return;
    const d = dialog;
    // Only keyboard-opened dialogs return focus to the Explorer on commit;
    // context-menu creates keep their existing behaviour (e.g. focus `type`).
    const commit = (path: string, opts?: { deleted?: boolean }) => {
      if (d.viaKeyboard) oncommit?.(path, opts);
    };
    if (d.kind === 'newConcept') {
      const name = d.value.trim();
      if (name === '') return;
      const file = name.endsWith('.md') ? name : `${name}.md`;
      const path = joinPath(childDirOf(d.node), file);
      const ok = await treeActions.createConcept(path);
      // Land in `type`: a scaffolded (non-reserved) Concept opens focused there.
      if (ok && !isReservedFile(path)) focusTypeForPath = path;
      dialog = null;
      if (ok) commit(path);
    } else if (d.kind === 'newFolder') {
      const name = d.value.trim();
      if (name === '') return;
      const path = joinPath(childDirOf(d.node), name);
      const ok = await treeActions.createFolder(path);
      dialog = null;
      if (ok) commit(path);
    } else if (d.kind === 'rename') {
      const raw = d.value.trim();
      // `.md` concepts hide their extension in the input, so re-append it unless
      // the user typed it back themselves. Folders/non-`.md` files are untouched.
      const isMd = !d.node.isDir && isMarkdownName(d.node.name);
      const name = isMd ? ensureMd(raw) : raw;
      if (raw === '' || name === d.node.name) {
        // No-op rename: nothing changed, so close like a cancel.
        closeDialog();
        return;
      }
      const path = joinPath(dirname(d.node.path), name);
      const ok = await treeActions.renamePath(d.node.path, path);
      dialog = null;
      if (ok) commit(path);
    } else if (d.kind === 'move') {
      const path = treeActions.resolveMove(d.node.path, d.value);
      const ok = await treeActions.movePath(d.node.path, d.value);
      dialog = null;
      if (ok) commit(path);
    } else if (d.kind === 'delete') {
      const ok = await treeActions.deletePath(d.node.path);
      dialog = null;
      if (ok) commit(d.node.path, { deleted: true });
    }
  }
</script>

{#if menu}
  <ContextMenu
    x={menu.x}
    y={menu.y}
    items={menuItems}
    onselect={onMenuSelect}
    onclose={() => (menu = null)}
  />
{/if}

{#if dialog}
  <div class="dialog-backdrop" role="presentation" onclick={closeDialog}></div>
  <div class="dialog" role="dialog" aria-modal="true" data-testid="tree-dialog">
    {#if dialog.kind === 'delete'}
      <p class="dialog-title">Delete “{dialog.node.name}”?</p>
      <p class="dialog-body">
        This {dialog.node.isDir ? 'folder and everything in it' : 'Concept'} will be
        permanently removed.
      </p>
      <div class="dialog-actions">
        <button type="button" onclick={closeDialog}>Cancel</button>
        <button
          type="button"
          class="danger"
          data-testid="dialog-confirm"
          onclick={confirmDialog}>Delete</button
        >
      </div>
    {:else if dialog.kind === 'move'}
      <p class="dialog-title">Move “{dialog.node.name}” to…</p>
      <select
        class="dialog-input"
        data-testid="dialog-move-target"
        bind:value={dialog.value}
      >
        {#each moveTargets as dir (dir)}
          <option value={dir}>{dir === '' ? '/ (Bundle root)' : dir}</option>
        {/each}
      </select>
      <div class="dialog-actions">
        <button type="button" onclick={closeDialog}>Cancel</button>
        <button type="button" data-testid="dialog-confirm" onclick={confirmDialog}>Move</button>
      </div>
    {:else}
      <p class="dialog-title">
        {dialog.kind === 'newConcept'
          ? 'New Concept'
          : dialog.kind === 'newFolder'
            ? 'New Folder'
            : 'Rename'}
      </p>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="dialog-input"
        type="text"
        data-testid="dialog-input"
        placeholder={dialog.kind === 'newConcept' ? 'name (.md optional)' : 'name'}
        bind:value={dialog.value}
        autofocus
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void confirmDialog();
          }
        }}
      />
      <div class="dialog-actions">
        <button type="button" onclick={closeDialog}>Cancel</button>
        <button type="button" data-testid="dialog-confirm" onclick={confirmDialog}>
          {dialog.kind === 'rename' ? 'Rename' : 'Create'}
        </button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1100;
    background: rgba(16, 22, 18, 0.4);
  }

  .dialog {
    position: fixed;
    z-index: 1101;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    min-width: 300px;
    padding: 1.25rem;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
    box-shadow: var(--shadow-lg);
  }

  .dialog-title {
    margin: 0 0 0.5rem;
    font-weight: 700;
  }

  .dialog-body {
    margin: 0 0 0.75rem;
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .dialog-input {
    width: 100%;
    box-sizing: border-box;
    padding: 0.5rem 0.65rem;
    margin-bottom: 0.9rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: inherit;
    font: inherit;
  }

  .dialog-input:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .dialog-actions button {
    padding: 0.4rem 0.9rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.12s ease;
  }

  .dialog-actions button:hover {
    background: var(--hover);
  }

  .dialog-actions button.danger {
    color: var(--danger-contrast);
    background: var(--danger);
    border-color: var(--danger);
  }
</style>
