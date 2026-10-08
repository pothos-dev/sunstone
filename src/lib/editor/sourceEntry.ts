// Where a `sources` entry sits in the Frontmatter YAML (ov-10), for the Sources
// section's Edit action: the Region opens with that entry unfolded, its
// siblings folded, and the caret on it. Pure, so it is unit-testable without
// CodeMirror; `frontmatterEditor.ts` applies it (`revealSource`).
//
// The entry is found by its list index (`Source.index`, counting every item as
// written), not by `id`: an entry may have no id, and ids may repeat.

import { isSeq, parseDocument } from 'yaml';

export interface SourceEntrySpan {
  /** Offset of the entry's first character (after its `- `): the caret goes here. */
  from: number;
  /** Offset just past the entry. */
  to: number;
  /** 0-based line of `from`: the entry's header line. */
  header: number;
  /** 0-based header lines of the other entries, to fold them away. */
  siblings: number[];
}

function lineOf(text: string, offset: number): number {
  let n = 0;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** The span of `sources[index]` in `yaml`, or `null` when there is no such entry. */
export function sourceEntrySpan(yaml: string, index: number): SourceEntrySpan | null {
  let doc;
  try {
    doc = parseDocument(yaml);
  } catch {
    return null;
  }
  const seq = doc.get('sources', true);
  if (!isSeq(seq)) return null;
  const starts = seq.items.map((item) => {
    const r = (item as { range?: [number, number, number] } | null)?.range;
    return r ? r : null;
  });
  const range = starts[index];
  if (!range) return null;
  const siblings: number[] = [];
  starts.forEach((r, i) => {
    if (r && i !== index) siblings.push(lineOf(yaml, r[0]));
  });
  return { from: range[0], to: range[1], header: lineOf(yaml, range[0]), siblings };
}
