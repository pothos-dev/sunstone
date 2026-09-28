// Outbound-link extraction + automatic link rewriting on rename/move for the
// fake backend (slice: link-auto-rewrite).
//
// The move/rename rewrite ENGINE is not ported here: `planRewrites` hands the
// in-memory corpus to the wasm `planMoveRewrites` export, which runs the same
// `sunstone_shared::rewrite::moves` engine as native `rename_and_rewrite`
// (ADR 0006 — no divergent TS twin). Inbound links (absolute -> new absolute;
// relative -> recomputed, style preserved), a moved Concept's own relative
// outbound links, folder moves, wikilinks and path-model Embeds all behave
// exactly as on the desktop / web backends.
//
// `outboundLinks` (Backlinks extraction) is still TS over the wasm resolvers.
//
// Reads the shared `FILES` state (imported live from `store`, never copied).

import type { RewriteSummary } from '$lib/types';
import {
  splitFrontmatter,
  resolveLinkIn,
  resolveWikilinkIn,
  planMoveRewrites,
} from '$lib/wasm/exports';
import { FILES, conceptPaths } from './store';

/**
 * Blank out fenced code blocks (``` / ~~~) and inline code spans in a markdown
 * body, preserving length + newlines so offsets stay aligned. Used so the
 * wikilink scanner never picks up `[[ … ]]` written inside code — the same
 * contract as the Rust `sunstone-shared::scan::walk_code`: a run of N backticks
 * opens a span only if a later run of EXACTLY N closes it within the same
 * paragraph (blank lines and fence lines end one); an unmatched run is literal.
 */
function maskCode(body: string): string {
  const lines = body.split('\n');
  // Only spaces/tabs may indent a fence, and only spaces/tabs (plus a CRLF's
  // `\r`) make a line blank — exactly the Rust walker's rules.
  const fenceRe = /^[ \t]*(`{3,}|~{3,})/;
  const blankRe = /^[ \t\r]*$/;
  let inFence = false;
  let fenceMarker = '';
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(...maskInlineCode(para.join('\n')).split('\n'));
    para = [];
  };
  for (const line of lines) {
    const fence = fenceRe.exec(line);
    if (fence) {
      flush();
      const marker = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      out.push(' '.repeat(line.length));
      continue;
    }
    if (inFence) {
      out.push(' '.repeat(line.length));
      continue;
    }
    if (blankRe.test(line)) {
      flush();
      out.push(line);
      continue;
    }
    para.push(line);
  }
  flush();
  return out.join('\n');
}

/** Blank CommonMark code spans (delimiters included) in one paragraph, keeping newlines. */
function maskInlineCode(text: string): string {
  const runs: { at: number; len: number }[] = [];
  for (const m of text.matchAll(/`+/g)) runs.push({ at: m.index, len: m[0].length });
  // Per run length, the next not-yet-passed run index (closers are searched
  // forward only, so each list is walked once).
  const byLen = new Map<number, number[]>();
  runs.forEach((r, k) => {
    const list = byLen.get(r.len);
    if (list) list.push(k);
    else byLen.set(r.len, [k]);
  });
  const cursor = new Map<number, number>();
  let res = '';
  let last = 0;
  for (let k = 0; k < runs.length; k++) {
    const { at, len } = runs[k];
    const same = byLen.get(len)!;
    let c = cursor.get(len) ?? 0;
    while (c < same.length && same[c] <= k) c++;
    cursor.set(len, c);
    if (c >= same.length) continue; // unmatched: literal text
    const close = same[c];
    const end = runs[close].at + len;
    res += text.slice(last, at) + text.slice(at, end).replace(/[^\n]/g, ' ');
    last = end;
    k = close;
  }
  return res + text.slice(last);
}

/** Matches a wikilink `[[ inner ]]` but NOT an embed `![[ … ]]` (leading `!`). */
const WIKILINK_RE = /(!?)\[\[([^\]]*)\]\]/g;

/**
 * Resolve every wikilink in a (code-masked) body to bundle paths via §1.
 * Embeds `![[ … ]]` are skipped — they point at an Attachment, which is not a
 * Backlinks endpoint (af-1). Returns resolved targets (may include
 * `sourcePath` for `[[#heading]]`).
 */
function wikilinkTargets(sourcePath: string, body: string): string[] {
  const masked = maskCode(body);
  const allPaths = conceptPaths();
  const targets: string[] = [];
  let m: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(masked)) !== null) {
    // An Embed never creates a Backlinks edge (af-1, the extraction half of
    // the deliberate `!`-asymmetry documented on `outboundLinks`).
    if (m[1] === '!') continue;
    const resolved = resolveWikilinkIn(allPaths, sourcePath, m[2]);
    if (resolved) targets.push(resolved.path);
  }
  return targets;
}

/**
 * Extract outbound internal link targets from a Concept's body, resolved.
 *
 * ## The `!`-asymmetry is DELIBERATE (af-1) — site 3 of 4
 *
 * EXTRACTION drops `!`; REWRITE (the shared engine behind `planRewrites`) does not. Do not
 * "restore symmetry" here: an Embed is not a Concept-to-Concept relationship,
 * so it must never create a Backlinks edge — which is what this drop
 * guarantees. That an Embed's *path* is still rewritten on a move is a
 * different question with a different answer. Twin of
 * `crates/sunstone-native/src/index/links.rs::markdown_link_hrefs`.
 */
export function outboundLinks(path: string, content: string): string[] {
  const { body } = splitFrontmatter(content);
  const paths = conceptPaths();
  const targets = new Set<string>();
  // [text](target) but NOT Embeds ![alt](src): require no `!` before `[`.
  const re = /(!?)\[[^\]]*\]\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[1] === '!') continue; // Embed — no Backlinks edge (see above)
    // Drop a trailing "title" inside the parens.
    const href = m[2].trim().split(/\s+/)[0];
    const resolved = resolveLinkIn(path, href, paths);
    if (resolved.kind === 'internal') targets.add(resolved.path);
  }
  // Wikilinks ([[name]]) resolve by name (§1) and also feed backlinks.
  for (const t of wikilinkTargets(path, body)) targets.add(t);
  // Drop self-edges (e.g. a pure same-file anchor [[#heading]]).
  targets.delete(path);
  return [...targets];
}

/**
 * Auto-rewrite links for a move of `from`->`to`, planned against the in-memory
 * FILES by the shared wasm engine. Reads content BEFORE the rename (snapshot),
 * so callers MUST call this BEFORE mutating FILES with the rename. Returns the
 * rewrite summary and a map of new-path -> rewritten content to apply AFTER the
 * rename.
 */
export function planRewrites(from: string, to: string): {
  summary: RewriteSummary;
  writes: Map<string, string>;
} {
  const concepts = conceptPaths().map((path) => ({ path, content: FILES[path] }));
  const plan = planMoveRewrites(from, to, concepts);
  return {
    summary: plan.summary,
    writes: new Map(plan.writes.map((w) => [w.path, w.content])),
  };
}
