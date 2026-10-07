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
  // and `sources[].id`s) by the shared scanner; each line looks its labels up.
  const sources = sourceList(body, splitFrontmatter(content).yaml ?? '');
  sourcesById = new Map();
  for (const s of sources) {
    const id = s.id?.toLowerCase();
    if (id && !sourcesById.has(id)) sourcesById.set(id, s);
  }
  footnotesByLabel = new Map(
    scanFootnotes(body, [...sourcesById.keys()]).map((f) => [f.label.toLowerCase(), f]),
  );

  const htmlParts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = byLine.get(i);
    if (h) {
      htmlParts.push(`<h${h.level} id="${h.slug}">${renderInline(h.text)}</h${h.level}>`);
      continue;
    }
    if (line.trim() === '') continue;
    // Paragraph lines can begin with a citation-table row (`[n] …`), so pass
    // the line-start flag through for citation definition detection.
    htmlParts.push(`<p>${renderInline(line, true)}</p>`);
  }

  htmlParts.push(renderSourcesSection(sources));
  return { html: htmlParts.join('\n'), frontmatter, outline };
}

/**
 * Render one line of inline text: CriticMarkup marks become their `critic-*`
 * HTML; text between marks is HTML-escaped. Marks are found with the shared
 * pure scanner so the fake and the editor agree on what a mark is.
 */
function renderInline(text: string, lineStart = false): string {
  const marks = parseCriticMarks(text);
  let out = '';
  let pos = 0;
  for (const mark of marks) {
    out += renderTextWithFootnotes(text.slice(pos, mark.from), lineStart && pos === 0);
    out += renderMark(mark);
    pos = mark.to;
  }
  out += renderTextWithFootnotes(text.slice(pos), lineStart && pos === 0);
  return out;
}

/** The body's footnotes by lowercase label (set by `renderConcept`). */
let footnotesByLabel = new Map<string, Footnote>();
/** The Concept's `sources` entries by lowercase id (set by `renderConcept`). */
let sourcesById = new Map<string, Source>();

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
    out += `<li><span class="source-num">${s.num ?? ''}</span><span class="source-body">${title}${resource}</span></li>`;
  }
  return out + '</ol></section>';
}

/**
 * Render footnotes to the SAME markup the Rust renderer emits
 * (`footnotes_to_sentinels`), handing the text between them to the citation
 * renderer. A definition counts only when this run is at the line start.
 * Omits Rust's `<br>` between consecutive definitions (one line per `<p>` here).
 */
function renderTextWithFootnotes(seg: string, atLineStart: boolean): string {
  let out = '';
  let p = 0;
  for (const f of scanFootnotes(seg)) {
    out += renderTextWithCitations(seg.slice(p, f.from), atLineStart && p === 0);
    const label = escapeHtml(f.label).replace(/"/g, '&quot;');
    // Labels match case-insensitively: one lowercased anchor, label as written.
    const anchor = escapeHtml(f.label.toLowerCase()).replace(/"/g, '&quot;');
    const whole = footnotesByLabel.get(f.label.toLowerCase()) ?? f;
    const source = sourcesById.get(f.label.toLowerCase());
    const n = whole.num;
    const sep = f.followsRef ? ',' : '';
    if (f.def && atLineStart) {
      out += `<a id="fn-${anchor}" class="footnote-def" title="${label}">${n}</a>`;
    } else if (source) {
      const d = sourceData(source);
      out +=
        source.kind === 'descriptor'
          ? `<sup class="footnote-ref source" ${d}>${sep}${n}</sup>`
          : `<sup class="footnote-ref source" ${d}>${sep}<a ${sourceLinkAttrs(source)}>${n}</a></sup>`;
    } else if (whole.hasDef) {
      out += `<sup class="footnote-ref" title="${label}">${sep}<a href="#fn-${anchor}">${n}</a></sup>`;
    } else if (whole.defined) {
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
