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
import { splitFrontmatter, parseFrontmatterFields } from '$lib/wasm/exports';
import { slugifyHeadings } from '$lib/slug';
import { parseCriticMarks, type CriticMark } from '$lib/editor/criticMarkup';
import { findCitationRefs } from '$lib/citations';

/** Render a Concept's raw markdown to the fake `RenderPayload`. */
export function renderConcept(content: string): RenderPayload {
  const frontmatter = parseFrontmatterFields(content);
  const { body } = splitFrontmatter(content);
  const lines = body.split('\n');

  // De-duplicate heading slugs across the whole document, GitHub-style — the
  // same rule the Rust outline uses (`slugifyHeadings` mirrors it).
  const headingTexts: string[] = [];
  for (const line of lines) {
    const h = headingMatch(line);
    if (h) headingTexts.push(h.text);
  }
  const slugs = slugifyHeadings(headingTexts);

  const outline: OutlineHeading[] = [];
  const htmlParts: string[] = [];
  let hi = 0;
  for (const line of lines) {
    const h = headingMatch(line);
    if (h) {
      const slug = slugs[hi++];
      outline.push({ level: h.level, text: h.text, slug });
      htmlParts.push(`<h${h.level} id="${slug}">${renderInline(h.text)}</h${h.level}>`);
      continue;
    }
    if (line.trim() === '') continue;
    // Paragraph lines can begin with a citation-table row (`[n] …`), so pass
    // the line-start flag through for citation definition detection.
    htmlParts.push(`<p>${renderInline(line, true)}</p>`);
  }

  return { html: htmlParts.join('\n'), frontmatter, outline };
}

/** An ATX heading line (`#`…`######` + space + text), or null. */
function headingMatch(line: string): { level: number; text: string } | null {
  const m = /^(#{1,6})\s+(.*)$/.exec(line);
  return m ? { level: m[1].length, text: m[2].trim() } : null;
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
    out += renderTextWithCitations(text.slice(pos, mark.from), lineStart && pos === 0);
    out += renderMark(mark);
    pos = mark.to;
  }
  out += renderTextWithCitations(text.slice(pos), lineStart && pos === 0);
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
