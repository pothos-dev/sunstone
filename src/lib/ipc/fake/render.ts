// A MINIMAL Concept renderer for the fake (browser/Playwright) backend.
//
// The real render lives in Rust core (`render.rs`) and leans on comrak, which
// isn't available here. This is a deliberately small stand-in — just enough to
// make the desktop print / CriticMarkup-annotation path meaningful in plain
// Chromium: it emits CriticMarkup marks to the SAME `critic-*` classes/markup
// the Rust renderer emits (so a print/annotation test is faithful), turns
// ATX headings into slugged `<hN>`, wraps other non-empty lines in `<p>`, and
// HTML-escapes everything outside a mark.
//
// What it intentionally OMITS vs Rust: link resolution (wikilinks/markdown
// links are left as escaped text), block markdown (lists, tables, code fences,
// emphasis inside a mark), and comrak's exact whitespace. The frontmatter and
// outline are populated minimally from the shared helpers.

import type { RenderPayload, OutlineHeading } from '$lib/types';
import {
  splitFrontmatter,
  frontmatterLineCount,
  parseFrontmatterFields,
  scanHeadings,
  parseCriticMarks,
  findCitationRefs,
  scanFootnotes,
  sourceList,
  type CriticMark,
  type Footnote,
  type Source,
} from '$lib/wasm/exports';
import { trustLineHtml } from '$lib/trust';
import { contractCardHtml } from '$lib/computation';
import { actorView } from '$lib/actor';
import { usageText } from '$lib/sourceCard';

/** Render a Concept's raw markdown to the fake `RenderPayload`. */
export function renderConcept(content: string): RenderPayload {
  const frontmatter = parseFrontmatterFields(content);
  const { body } = splitFrontmatter(content);
  const lines = body.split('\n');

  // Headings + de-duplicated slugs come from the SHARED `scanHeadings` (ADR 0006
  // family 13 — the same ATX scan the editor + native SSR render use; retires the
  // former local `headingMatch` + `slugifyHeadings`). Map each heading's body
  // line index (full-document line minus the frontmatter offset) to its entry.
  const outline: OutlineHeading[] = scanHeadings(content);
  const offset = frontmatterLineCount(content);
  const byLine = new Map<number, OutlineHeading>();
  for (const h of outline) byLine.set(h.line - offset - 1, h);

  // Every footnote of the whole body, numbered and resolved (body definitions
  // and `sources[].id`s) by ONE shared scan, which knows about fences and
  // Embeds; each line takes the footnotes inside it, shifted to line offsets.
  const sources = sourceList(body, splitFrontmatter(content).yaml ?? '');
  sourcesById = new Map();
  for (const s of sources) {
    const id = s.id?.toLowerCase();
    if (id && !sourcesById.has(id)) sourcesById.set(id, s);
  }
  const notes = scanFootnotes(body, [...sourcesById.keys()]);
  const lineNotes = footnotesByLine(notes, lines);
  anchored = new Set();
  cited = new Map();
  // A body definition for a `sources` id is dropped: its text shows on the
  // Sources entry (ov-10), as in Rust's `footnotes_to_sentinels`.
  const hidden = new Set(
    lineNotes.flatMap((ns, i) => (ns.some((f) => f.def && sourcesById.has(f.label.toLowerCase())) ? [i] : [])),
  );

  // The trust line opens the body (ov-9), as in the native render.
  const htmlParts: string[] = [];
  const trust = trustLineHtml(splitFrontmatter(content).yaml ?? '');
  if (trust) htmlParts.push(trust);
  // An Attested Computation's contract card follows it (ov-12), as in Rust.
  const card = contractCardHtml(splitFrontmatter(content).yaml ?? '');
  if (card) htmlParts.push(card);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (hidden.has(i)) continue;
    const h = byLine.get(i);
    if (h) {
      // The heading text sits inside its line; shift the line's footnotes to it.
      const at = line.indexOf(h.text);
      const notes = at < 0 ? [] : shift(lineNotes[i], at, at + h.text.length);
      htmlParts.push(`<h${h.level} id="${h.slug}">${renderInline(h.text, notes)}</h${h.level}>`);
      continue;
    }
    if (line.trim() === '') continue;
    // Paragraph lines can begin with a citation-table row (`[n] …`), so pass
    // the line-start flag through for citation definition detection.
    htmlParts.push(`<p>${renderInline(line, lineNotes[i], true)}</p>`);
  }

  htmlParts.push(renderSourcesSection(sources));
  return { html: htmlParts.join('\n'), frontmatter, outline };
}

/**
 * The whole-body footnotes split per line (`lines` is the body split on `\n`),
 * each with offsets relative to its line.
 */
function footnotesByLine(all: Footnote[], lines: string[]): Footnote[][] {
  const out: Footnote[][] = lines.map(() => []);
  let start = 0;
  let k = 0;
  for (let i = 0; i < lines.length; i++) {
    const end = start + lines[i].length;
    while (k < all.length && all[k].from < end) {
      if (all[k].from >= start) out[i].push({ ...all[k], from: all[k].from - start, to: all[k].to - start });
      k++;
    }
    start = end + 1;
  }
  return out;
}

/** The footnotes lying wholly within `[from, to)`, shifted to start at `from`. */
function shift(notes: Footnote[], from: number, to: number): Footnote[] {
  return notes
    .filter((f) => f.from >= from && f.to <= to)
    .map((f) => ({ ...f, from: f.from - from, to: f.to - from }));
}

/**
 * Render one line of inline text: CriticMarkup marks become their `critic-*`
 * HTML; text between marks is HTML-escaped. Marks are found with the shared
 * pure scanner so the fake and the editor agree on what a mark is. `notes` are
 * the footnotes of `text` (from the whole-body scan); one inside a mark stays
 * text, as the mark's content is escaped whole.
 */
function renderInline(text: string, notes: Footnote[], lineStart = false): string {
  const marks = parseCriticMarks(text);
  let out = '';
  let pos = 0;
  for (const mark of marks) {
    out += renderTextWithFootnotes(text.slice(pos, mark.from), shift(notes, pos, mark.from), lineStart && pos === 0);
    out += renderMark(mark);
    pos = mark.to;
  }
  out += renderTextWithFootnotes(text.slice(pos), shift(notes, pos, text.length), lineStart && pos === 0);
  return out;
}

/** Lowercased labels whose first definition was rendered (reset per render). */
let anchored = new Set<string>();
/** The Concept's `sources` entries by lowercase id (set by `renderConcept`). */
let sourcesById = new Map<string, Source>();
/** Source references rendered so far per lowercase label (reset per render). */
let cited = new Map<string, number>();

/**
 * The anchor attributes for a source's resource. The fake does not resolve
 * links (see the header), so the resource stays the raw `href`.
 */
function sourceLinkAttrs(s: Source): string {
  return `href="${attr(s.resource)}"`;
}

/** `data-source="…"`: the entry as JSON for the hover card (Rust's `source_data`). */
function sourceData(s: Source): string {
  return `data-source="${attr(JSON.stringify(s))}"`;
}

/** The Sources section, in the SAME markup as Rust's `sources_section_html`. */
function renderSourcesSection(list: Source[]): string {
  if (list.length === 0) return '';
  let out = `<section class="sources"><div class="sources-heading">Sources</div><ol class="sources-list">`;
  for (const s of list) {
    const d = sourceData(s);
    const label = attr(s.title ?? s.resource);
    const title =
      s.kind === 'descriptor'
        ? `<span class="source-title" ${d}>${label}</span>`
        : `<a ${sourceLinkAttrs(s)} ${d}><span class="source-title">${label}</span></a>`;
    const resource =
      s.title != null && s.resource
        ? `<span class="source-resource">${attr(s.resource)}</span>`
        : '';
    const note = s.note ? `<span class="source-note">${attr(s.note)}</span>` : '';
    out += `<li><span class="source-num">${s.num ?? ''}</span><span class="source-body">${title}${resource}${renderSignals(s)}${note}${renderBackrefs(s)}</span></li>`;
  }
  return out + '</ol></section>';
}

/** Rust's `signals_html`: the credibility signals as written. */
function renderSignals(s: Source): string {
  const items: string[] = [];
  const push = (key: string, value: string) =>
    items.push(`<span class="source-signal"><span class="source-signal-key">${key}</span> ${value}</span>`);
  if (s.author) push('Author', renderActor(s.author));
  if (s.lastModified) push('Last modified', attr(s.lastModified));
  const usage = usageText(s);
  if (usage) push('Usage count', attr(usage));
  return items.length ? `<span class="source-signals">${items.join('')}</span>` : '';
}

/** Rust's `actor_html`: the markup of `actorElement`. */
function renderActor(raw: string): string {
  const v = actorView(raw);
  const chip = v.kindLabel ? `<span class="actor-kind">${v.kindLabel}</span>` : '';
  const version = v.version ? `<span class="actor-version">${attr(v.version)}</span>` : '';
  return `<span class="actor actor-${v.kind}" title="${attr(v.title)}">${chip}<span class="actor-id">${attr(v.text)}</span>${version}</span>`;
}

/** Rust's `backrefs_html`: a jump back to each citing claim. */
function renderBackrefs(s: Source): string {
  const n = s.refs.length;
  if (!s.id || n === 0) return '';
  const anchor = attr(s.id.toLowerCase());
  const links = s.refs.map((_, i) => {
    const k = i + 1;
    const text = n === 1 ? '↑' : k <= 26 ? String.fromCharCode(96 + k) : `${k}`;
    return `<a class="source-backref" href="#fnref-${anchor}-${k}" title="Jump to citation ${k}">${text}</a>`;
  });
  return `<span class="source-backrefs">${n === 1 ? '' : '↑ '}${links.join(' ')}</span>`;
}

/**
 * Render `notes` (the footnotes of `seg`, segment offsets) to the SAME markup
 * the Rust renderer emits (`footnotes_to_sentinels`), handing the text between
 * them to the citation renderer. A definition counts only when this run is at
 * the line start, and only a label's first definition carries the `fn-` id.
 * Omits Rust's leading `<br>` on a definition (one line per `<p>` here).
 */
function renderTextWithFootnotes(seg: string, notes: Footnote[], atLineStart: boolean): string {
  let out = '';
  let p = 0;
  for (const f of notes) {
    out += renderTextWithCitations(seg.slice(p, f.from), atLineStart && p === 0);
    const label = escapeHtml(f.label).replace(/"/g, '&quot;');
    // Labels match case-insensitively: one lowercased anchor, label as written.
    const anchor = escapeHtml(f.label.toLowerCase()).replace(/"/g, '&quot;');
    const source = sourcesById.get(f.label.toLowerCase());
    const n = f.num;
    const sep = f.followsRef ? ',' : '';
    if (f.def && atLineStart) {
      const id = anchored.has(f.label.toLowerCase()) ? '' : `id="fn-${anchor}" `;
      anchored.add(f.label.toLowerCase());
      out += `<a ${id}class="footnote-def" title="${label}">${n}</a>`;
    } else if (source) {
      const d = sourceData(source);
      const k = (cited.get(f.label.toLowerCase()) ?? 0) + 1;
      cited.set(f.label.toLowerCase(), k);
      const id = `id="fnref-${anchor}-${k}"`;
      out +=
        source.kind === 'descriptor'
          ? `<sup ${id} class="footnote-ref source" ${d}>${sep}${n}</sup>`
          : `<sup ${id} class="footnote-ref source" ${d}>${sep}<a ${sourceLinkAttrs(source)}>${n}</a></sup>`;
    } else if (f.hasDef) {
      out += `<sup class="footnote-ref" title="${label}">${sep}<a href="#fn-${anchor}">${n}</a></sup>`;
    } else if (f.defined) {
      out += `<sup class="footnote-ref" title="${label}">${sep}${n}</sup>`;
    } else {
      out += `<sup class="footnote-ref broken" title="${label}">${sep}${n}</sup>`;
    }
    p = f.to;
  }
  out += renderTextWithCitations(seg.slice(p), atLineStart && p === 0);
  return out;
}

/**
 * Escape a run of plain text, rendering citations to the SAME markup the Rust
 * renderer emits (`citations_to_sentinels`): a leading `[n]` (only when this run
 * is at the line start) becomes the literal `[n]` jump target; every inline
 * `[n]` following a word becomes a superscript link. Mirrors `$lib/citations`.
 */
function renderTextWithCitations(seg: string, atLineStart: boolean): string {
  let out = '';
  let cursor = 0;
  if (atLineStart) {
    const def = /^([ \t]*)\[(\d+)\]/.exec(seg);
    if (def) {
      out += escapeHtml(def[1]);
      out += `<a id="cite-${def[2]}" class="citation-def">[${def[2]}]</a>`;
      cursor = def[0].length;
    }
  }
  const rest = seg.slice(cursor);
  let p = 0;
  for (const ref of findCitationRefs(rest)) {
    out += escapeHtml(rest.slice(p, ref.from));
    out += `<sup class="citation-ref"><a href="#cite-${ref.num}">[${ref.num}]</a></sup>`;
    p = ref.to;
  }
  out += escapeHtml(rest.slice(p));
  return out;
}

/** One CriticMarkup mark → the exact HTML the Rust renderer emits. */
function renderMark(mark: CriticMark): string {
  switch (mark.kind) {
    case 'addition':
      return `<ins class="critic-add">${escapeHtml(mark.text ?? '')}</ins>`;
    case 'deletion':
      return `<del class="critic-del">${escapeHtml(mark.text ?? '')}</del>`;
    case 'highlight':
      return `<mark class="critic-highlight">${escapeHtml(mark.text ?? '')}</mark>`;
    case 'substitution': {
      const deleted = `<del class="critic-del">${escapeHtml(mark.deleted ?? '')}</del>`;
      // No `~>` (empty inserted) renders as a plain deletion, matching Rust.
      const inserted = mark.inserted
        ? `<ins class="critic-add">${escapeHtml(mark.inserted)}</ins>`
        : '';
      return deleted + inserted;
    }
    case 'comment':
      return (
        `<span class="critic-comment">` +
        `<span class="critic-comment-icon" aria-hidden="true"></span>` +
        `<span class="critic-comment-text">${escapeHtml(mark.text ?? '')}</span>` +
        `</span>`
      );
  }
}

/** Escape text for HTML body/attribute context (the chars the Rust side escapes). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape for a double-quoted attribute value (Rust's `attr_escape`). */
function attr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
