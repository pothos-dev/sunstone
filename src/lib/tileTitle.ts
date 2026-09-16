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

/**
 * Derive the header label for the Tile showing `path` with the frontmatter block
 * `yaml` (the inner YAML, no fences). Prefers a non-empty scalar `title`;
 * otherwise the filename stem (basename without the `.md` extension) — which is
 * also what an unparseable block falls back to, since the header must render
 * something while the author is mid-edit (ADR 0008). Returns `''` when nothing
 * is open, so the header can render an empty label.
 */
export function tileTitle(path: string | null, yaml: string): string {
  if (path === null) return '';
  return titleFromYaml(yaml) ?? stripMd(basename(path));
}

/**
 * The header label split into its bundle-relative FOLDER prefix and the Concept
 * name, so the Tile header can show where the Concept lives (concept-header-path)
 * instead of the bare name. `dir` carries its trailing `/` (`'concepts/editor/'`)
 * and is `''` for a root-level Concept or an empty Tile; `name` is `tileTitle`.
 */
export function tileHeaderLabel(
  path: string | null,
  yaml: string,
): { dir: string; name: string } {
  const name = tileTitle(path, yaml);
  if (path === null) return { dir: '', name };
  const dir = dirname(path);
  return { dir: dir === '' ? '' : `${dir}/`, name };
}
