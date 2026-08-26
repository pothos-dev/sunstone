// Pure tree/menu helpers for the Tree CRUD feature (extracted from
// TreeCrud.svelte so they can be unit-tested). All functions operate on plain
// `TreeNode` values — no DOM, no stores.
//
// Deliberately NOT in `treeNav.ts`: that module's charter is the flattened
// VISIBLE-row math for Explorer keyboard navigation (collapse-aware, reserved
// files excluded), while these helpers walk the FULL tree (every folder, any
// node by path) to drive the CRUD context menu and dialogs.

import type { TreeNode } from '$lib/types';
import { dirname, stripMd } from '$lib/path';
import { reservedPath, RESERVED_FILES, type ReservedKind } from '$lib/reserved';

/**
 * Folder a NEW child of `node` should live in: the node itself if it's a
 * directory, else its containing folder.
 */
export function childDirOf(node: TreeNode): string {
  return node.isDir ? node.path : dirname(node.path);
}

/** All folder paths in the tree (for the Move picker), '' = Bundle root. */
export function folderPaths(node: TreeNode, out: string[] = []): string[] {
  if (node.isDir) {
    out.push(node.path);
    for (const child of node.children ?? []) folderPaths(child, out);
  }
  return out;
}

/** Find the tree node at bundle-relative `path` (the Bundle root is `''`). */
export function nodeAt(root: TreeNode | null, path: string): TreeNode | null {
  if (!root) return null;
  if (path === root.path) return root;
  const walk = (n: TreeNode): TreeNode | null => {
    if (n.path === path) return n;
    for (const c of n.children ?? []) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
}

/**
 * Initial text for the rename input. A `.md` concept is shown WITHOUT its
 * extension — the `.md` is implicit and re-appended on confirm (mirrors the
 * tree's display name). Folders and non-`.md` files keep their full name.
 */
export function renameSeed(node: TreeNode): string {
  return node.isDir ? node.name : stripMd(node.name);
}

/** Whether `dir` (a folder node) already contains the reserved file `kind`. */
export function folderHasReserved(dir: TreeNode, kind: ReservedKind): boolean {
  const target = reservedPath(dir.path, kind);
  return (dir.children ?? []).some((c) => !c.isDir && c.path === target);
}

/** One entry of the tree context menu. */
export interface TreeMenuItem {
  id: string;
  label: string;
  separated?: boolean;
  danger?: boolean;
}

/**
 * Context-menu items for `node`. A FOLDER additionally offers to create
 * whichever reserved file (`index.md`/`log.md`) it is missing, and to delete
 * whichever it has (slice: reserved-files) — reserved files are not ordinary
 * tree leaves (only their symbol shows on the folder row), so the folder menu
 * is the only right-click surface that can reach them. The Bundle root counts
 * as a folder here too.
 */
export function menuItemsFor(node: TreeNode): TreeMenuItem[] {
  const items: TreeMenuItem[] = [
    { id: 'newConcept', label: 'New Concept' },
    { id: 'newFolder', label: 'New Folder' },
  ];
  const deleteReserved: TreeMenuItem[] = [];
  if (node.isDir) {
    const kinds: ReservedKind[] = ['index', 'log'];
    let first = true;
    for (const kind of kinds) {
      if (folderHasReserved(node, kind)) {
        deleteReserved.push({
          id: `deleteReserved:${kind}`,
          label: `Delete ${RESERVED_FILES[kind]}`,
          danger: true,
        });
        continue;
      }
      items.push({
        id: `createReserved:${kind}`,
        label: `Create ${RESERVED_FILES[kind]}`,
        separated: first,
      });
      first = false;
    }
  }
  items.push(
    { id: 'rename', label: 'Rename', separated: true },
    { id: 'move', label: 'Move…' },
    { id: 'delete', label: 'Delete', separated: true, danger: true },
    ...deleteReserved,
  );
  return items;
}
