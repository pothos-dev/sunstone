import { splitWikilinkTarget } from '$lib/wasm/exports';

/**
 * Display-side helpers over a raw wikilink inner text (`name|alias#anchor`).
 * Resolution itself lives on the wasm handle (`resolveWikilink`); these are the
 * small splits the label and the open-scroll need.
 */

/**
 * The `#anchor` to scroll to when a wikilink opens, or `null`. Delegates to the
 * wasm `parse_target`, so both `[[name#anchor|alias]]` and
 * `[[name|alias#anchor]]` carry their anchor.
 */
export function wikilinkAnchor(raw: string): string | null {
  const { anchor } = splitWikilinkTarget(raw);
  return anchor && anchor.trim() !== '' ? anchor : null;
}

/**
 * Display label for a resolved bare wikilink (the aliased `[[a|b]]` case keeps
 * its own label via the upstream decoration). Prefer the author's written name
 * — everything before the first `|` or `#`, as typed (Obsidian shows what was
 * typed); fall back to the resolved file's basename for a pure same-file
 * anchor `[[#heading]]`.
 */
export function wikilinkLabel(raw: string, resolvedPath: string): string {
  const end = [raw.indexOf('|'), raw.indexOf('#')].filter((i) => i !== -1);
  const written = raw.slice(0, end.length ? Math.min(...end) : raw.length).trim();
  if (written !== '') return written;
  const base = resolvedPath.slice(resolvedPath.lastIndexOf('/') + 1);
  return base.replace(/\.md$/i, '');
}
