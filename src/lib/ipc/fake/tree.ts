// Tree construction + path-mutating filesystem operations for the fake backend.
//
// Operates on the shared `FILES` / `FOLDERS` state (imported live from `store`,
// never copied). `buildTree` derives the recursive TreeNode from the flat FILES
// map; `applyRename` / `applyDelete` mutate FILES + FOLDERS in place,
// mirroring the real backend's directory semantics.

import type { TreeNode } from '$lib/types';
import { basename, dirname, remapPath } from '$lib/path';
import { FILES, FOLDERS, fileExists, folderExists, pathExists } from './store';

/**
 * Build the recursive TreeNode for the fixture from the flat FILES map.
 * Directories are inferred from path segments; only `.md` files are listed
 * (the fixture contains only markdown, mirroring an OKF Bundle's focus).
 */
export function buildTree(): TreeNode {
  const root: TreeNode = { name: 'bundle', path: '', isDir: true, children: [] };

  // dirPath ('' for root) -> TreeNode
  const dirs = new Map<string, TreeNode>();
  dirs.set('', root);

  const ensureDir = (dirPath: string): TreeNode => {
    const existing = dirs.get(dirPath);
    if (existing) return existing;

    const parent = ensureDir(dirname(dirPath));

    const node: TreeNode = { name: basename(dirPath), path: dirPath, isDir: true, children: [] };
    parent.children!.push(node);
    dirs.set(dirPath, node);
    return node;
  };

  // Explicitly-created empty folders (and their ancestors).
  for (const folder of FOLDERS) ensureDir(folder);

  for (const path of Object.keys(FILES)) {
    ensureDir(dirname(path)).children!.push({ name: basename(path), path, isDir: false });
  }

  // Sort each directory: dirs first, then files, alphabetically.
  const sortNode = (node: TreeNode) => {
    if (!node.children) return;
    node.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortNode);
  };
  sortNode(root);

  return root;
}

/**
 * Rename/move `from` to `to`, handling both a single Concept and a folder
 * (rewriting every descendant path). Mutates FILES + FOLDERS in place.
 */
export function applyRename(from: string, to: string): void {
  if (!pathExists(from)) throw new Error(`no such path: ${from}`);
  if (pathExists(to)) throw new Error(`already exists: ${to}`);
  // Mirror the Rust `rename_path` guard: the target's parent folder must exist
  // (a real `fs::rename` would otherwise fail). `''` is the Bundle root, always
  // present. Checked before any mutation so a rejected rename is a no-op.
  const parent = dirname(to);
  if (parent !== '' && !folderExists(parent)) {
    throw new Error(`target folder does not exist: ${to}`);
  }

  if (fileExists(from)) {
    // Single file.
    FILES[to] = FILES[from];
    delete FILES[from];
    return;
  }

  // Folder: move it and every descendant (files + tracked subfolders). `from`
  // itself is not a FILES key here (that was the single-file branch), so only
  // descendants remap; a tracked FOLDERS entry may be `from` itself.
  for (const p of Object.keys(FILES)) {
    const dest = remapPath(p, from, to);
    if (dest !== null) {
      FILES[dest] = FILES[p];
      delete FILES[p];
    }
  }
  for (const f of [...FOLDERS]) {
    const dest = remapPath(f, from, to);
    if (dest !== null) {
      FOLDERS.delete(f);
      FOLDERS.add(dest);
    }
  }
  FOLDERS.add(to);
}

/**
 * Delete `path` (file or folder, recursively). Returns the list of removed
 * paths (so each can be reported as a `removed` change).
 */
export function applyDelete(path: string): string[] {
  const removed: string[] = [];
  if (fileExists(path)) {
    delete FILES[path];
    removed.push(path);
    return removed;
  }
  if (folderExists(path)) {
    const prefix = `${path}/`;
    for (const p of Object.keys(FILES)) {
      if (p.startsWith(prefix)) {
        delete FILES[p];
        removed.push(p);
      }
    }
    for (const f of [...FOLDERS]) {
      if (f === path || f.startsWith(prefix)) FOLDERS.delete(f);
    }
    removed.push(path);
  }
  return removed;
}
