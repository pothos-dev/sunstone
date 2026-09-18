import type { SyntaxNode } from '@lezer/common';

/**
 * The `URL` child that is a markdown `Link` node's DESTINATION, or `null` when
 * the Link has none (a bracketed span like `[1]` with no reference definition).
 *
 * A `Link` can carry TWO direct `URL` children: GFM autolinking turns a bare URL
 * or email address in the link LABEL into its own `URL` node, so
 * `[a@b.c](mailto:a@b.c)` parses as `[`, URL(label), `]`, `(`, URL(dest), `)`.
 * Taking the first `URL` child therefore reads the label as the href. Which one
 * is the destination is a positional question: the label ends at the closing `]`
 * — the Link's second `LinkMark` — so only a `URL` starting after it qualifies.
 *
 * Mirrored in the patched atomic-editor inline preview (`destinationUrlNode`),
 * which needs the same answer to decide that an autolinked label must stay
 * VISIBLE rather than be hidden as link syntax.
 */
export function destinationUrlNode(link: SyntaxNode): SyntaxNode | null {
  const marks = link.getChildren('LinkMark');
  const labelEnd = marks.length > 1 ? marks[1].to : link.from;
  return link.getChildren('URL').find((u) => u.from >= labelEnd) ?? null;
}
