// Per-Tile header title derivation (pure; no DOM/IPC/runes).
//
// A Tile's header shows a compact label for the active Concept. The label
// prefers the Concept's frontmatter `title` (a human-authored display name),
// falling back to the filename stem when no usable title is set. Kept as a pure
// helper so the TileHeader component stays thin and the rule is unit-testable.

import { basename, dirname, stripMd } from '$lib/path';
import type { Property } from '$lib/frontmatter';

/**
 * Derive the header label for the Tile showing `path` with `properties`
 * (the active Concept's parsed frontmatter). Prefers a non-empty scalar `title`
 * property; otherwise the filename stem (basename without the `.md` extension).
 * Returns `''` when nothing is open, so the header can render an empty label.
 */
export function tileTitle(path: string | null, properties: Property[]): string {
  if (path === null) return '';
  const titleProp = properties.find((p) => p.key === 'title' && p.kind === 'scalar');
  const title = titleProp?.scalar?.trim();
  if (title) return title;
  return stripMd(basename(path));
}

/**
 * The header label split into its bundle-relative FOLDER prefix and the Concept
 * name, so the Tile header can show where the Concept lives (concept-header-path)
 * instead of the bare name. `dir` carries its trailing `/` (`'concepts/editor/'`)
 * and is `''` for a root-level Concept or an empty Tile; `name` is `tileTitle`.
 */
export function tileHeaderLabel(
  path: string | null,
  properties: Property[],
): { dir: string; name: string } {
  const name = tileTitle(path, properties);
  if (path === null) return { dir: '', name };
  const dir = dirname(path);
  return { dir: dir === '' ? '' : `${dir}/`, name };
}
