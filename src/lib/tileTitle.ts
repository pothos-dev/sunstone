// Per-Tile header title derivation (pure; no DOM/IPC/runes).
//
// A Tile's header shows a compact label for the active Concept. The label
// prefers the Concept's frontmatter `title` (a human-authored display name),
// falling back to the filename stem when no usable title is set. With ADR 0008
// the frontmatter is YAML text, so the title is PARSED out of it here — the
// structured mirror it used to read is gone. Kept as a pure helper so the
// TileHeader component stays thin and the rule is unit-testable.

import { basename, dirname, stripMd } from '$lib/path';
import { titleFromYaml } from '$lib/frontmatter';
import { findFolder, folderIndexPath, folderTitle } from '$lib/treeNav';
import { reservedKind } from '$lib/reserved';
import type { TreeNode } from '$lib/types';

/**
 * Derive the header label for the Tile showing `path` with the frontmatter block
 * `yaml` (the inner YAML, no fences). Prefers a non-empty scalar `title`;
 * otherwise the filename stem (basename without the `.md` extension) — which is
 * also what an unparseable block falls back to, since the header must render
 * something while the author is mid-edit (ADR 0008). Returns `''` when nothing
 * is open, so the header can render an empty label. With `useTitles` off (the
 * left-rail toggle) it is always the filename stem.
 */
export function tileTitle(path: string | null, yaml: string, useTitles = true): string {
  if (path === null) return '';
  return (useTitles && titleFromYaml(yaml)) || stripMd(basename(path));
}

/**
 * The header label split into its bundle-relative FOLDER prefix and the Concept
 * name, so the Tile header can show where the Concept lives (concept-header-path)
 * instead of the bare name. `dir` carries its trailing `/` (`'concepts/editor/'`)
 * and is `''` for a root-level Concept or an empty Tile; `name` is `tileTitle`.
 *
 * A titled folder `index.md` stands for its folder, which the Explorer already
 * labels by that title: with `useTitles` its own folder is dropped from the
 * prefix, so `customers/index.md` titled `Kunden` reads `Kunden`, not
 * `Kunden/Kunden`.
 */
export function tileHeaderLabel(
  path: string | null,
  yaml: string,
  useTitles = true,
): { dir: string; name: string; crumbs: Crumb[] } {
  const name = tileTitle(path, yaml, useTitles);
  if (path === null) return { dir: '', name, crumbs: [] };
  let dir = dirname(path);
  if (useTitles && dir !== '' && reservedKind(path) === 'index' && titleFromYaml(yaml) !== null) {
    dir = dirname(dir);
  }
  return { dir: dir === '' ? '' : `${dir}/`, name, crumbs: folderCrumbs(dir) };
}

/** One ancestor folder of the open Concept, as a clickable header breadcrumb. */
export interface Crumb {
  /** The folder's own name (`editor`). */
  name: string;
  /** The folder's bundle-relative path (`concepts/editor`). */
  folder: string;
}

/**
 * The breadcrumbs for the folder `dir` (bundle-relative, `''` for the root):
 * one per folder from the outermost down, each carrying its full path.
 */
export function folderCrumbs(dir: string): Crumb[] {
  if (dir === '') return [];
  const parts = dir.split('/');
  return parts.map((name, i) => ({ name, folder: parts.slice(0, i + 1).join('/') }));
}

/** A header breadcrumb plus its folder's `index.md` path (`null` = none). */
export type IndexedCrumb = Crumb & { index: string | null };

/**
 * Attach each crumb's folder `index.md` (looked up in the Bundle `tree`), which
 * a header breadcrumb click opens. `index` is `null` for a folder without one,
 * or for every crumb while the tree is not loaded. With `useTitles`, a crumb is
 * named by its folder's `index.md` title, as in the Explorer.
 */
export function indexCrumbs(
  crumbs: Crumb[],
  tree: TreeNode | null,
  useTitles = true,
): IndexedCrumb[] {
  return crumbs.map((c) => {
    const folder = useTitles ? findFolder(tree, c.folder) : null;
    const name = (folder && folderTitle(folder)) || c.name;
    return { ...c, name, index: folderIndexPath(tree, c.folder) };
  });
}

/**
 * Every ancestor folder of `folder`, itself included, outermost first
 * (`a/b/c` → `a`, `a/b`, `a/b/c`): the folders to expand so `folder`'s
 * row is visible in the Explorer.
 */
export function foldersToExpand(folder: string): string[] {
  return folderCrumbs(folder).map((c) => c.folder);
}

/**
 * The desktop window title for the active Concept: its header label followed by
 * the app name (`CodeMirror 6 — Sunstone`), or just `Sunstone` when nothing is
 * open.
 */
export function windowTitle(path: string | null, yaml: string, useTitles = true): string {
  const name = tileTitle(path, yaml, useTitles);
  return name === '' ? 'Sunstone' : `${name} — Sunstone`;
}
