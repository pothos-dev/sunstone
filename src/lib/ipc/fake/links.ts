// Outbound-link extraction + automatic link rewriting on rename/move for the
// fake backend (slice: link-auto-rewrite).
//
// Ports the Rust `rewrite.rs` path math so the same two-directional, path-aware
// behaviour is exercised under Chromium/Playwright:
//   * inbound links (absolute -> new absolute; relative -> recomputed from the
//     source's own dir, preserving relative style);
//   * the moved Concept's own relative outbound links (recomputed from its NEW
//     dir; absolute links untouched);
//   * folder moves apply both to every contained Concept (co-moved siblings'
//     internal relative links stay valid, never double-broken).
// Only links whose resolved target IS a moved Concept change; anchors, queries,
// titles, link text and external links are preserved.
//
// Reads the shared `FILES` state (imported live from `store`, never copied).

import type { RewriteSummary } from '$lib/types';
import { resolveLink, isExternalLink, resolveWikilink, splitWikilinkTarget } from './linkResolve';
import { splitFrontmatter } from '$lib/wasm/exports';
import { FILES, conceptPaths } from './store';

/**
 * Blank out fenced code blocks (``` / ~~~) and inline code spans (`` ` ``) in a
 * markdown body, preserving length + newlines so offsets stay aligned. Used so
 * the wikilink scanner never picks up `[[ … ]]` written inside code, matching
 * Obsidian / the outline scanner's fence handling.
 */
function maskCode(body: string): string {
  const lines = body.split('\n');
  const fenceRe = /^\s*(`{3,}|~{3,})/;
  let inFence = false;
  let fenceMarker = '';
  const out: string[] = [];
  for (const line of lines) {
    const fence = fenceRe.exec(line);
    if (fence) {
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
    // Inline code spans: blank the content between matched backtick runs.
    out.push(line.replace(/`+[^`]*`+/g, (s) => ' '.repeat(s.length)));
  }
  return out.join('\n');
}

/** Matches a wikilink `[[ inner ]]` but NOT an embed `![[ … ]]` (leading `!`). */
const WIKILINK_RE = /(!?)\[\[([^\]]*)\]\]/g;

/**
 * Resolve every wikilink in a (code-masked) body to bundle paths via §1.
 * Embeds `![[ … ]]` are skipped (out of scope for v1). Returns resolved
 * targets (may include `sourcePath` for `[[#heading]]`).
 */
function wikilinkTargets(sourcePath: string, body: string): string[] {
  const masked = maskCode(body);
  const allPaths = conceptPaths();
  const targets: string[] = [];
  let m: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(masked)) !== null) {
    if (m[1] === '!') continue; // embed, not a link (deferred)
    const resolved = resolveWikilink(allPaths, sourcePath, m[2]);
    if (resolved) targets.push(resolved.path);
  }
  return targets;
}

/** Extract outbound internal link targets from a Concept's body, resolved. */
export function outboundLinks(path: string, content: string): string[] {
  const { body } = splitFrontmatter(content);
  const targets = new Set<string>();
  // [text](target) but NOT images ![alt](src): require no `!` before `[`.
  const re = /(!?)\[[^\]]*\]\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[1] === '!') continue; // image, not a Concept link
    // Drop a trailing "title" inside the parens.
    const href = m[2].trim().split(/\s+/)[0];
    const resolved = resolveLink(path, href);
    if (resolved.kind === 'internal') targets.add(resolved.path);
  }
  // Wikilinks ([[name]]) resolve by name (§1) and also feed backlinks.
  for (const t of wikilinkTargets(path, body)) targets.add(t);
  // Drop self-edges (e.g. a pure same-file anchor [[#heading]]).
  targets.delete(path);
  return [...targets];
}

/** Directory portion of a bundle-relative path ('' for a root-level file). */
function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** Relative path FROM `fromDir` TO bundle-relative `target`, with `./`/`../`. */
function relativePath(fromDir: string, target: string): string {
  const from = fromDir === '' ? [] : fromDir.split('/');
  const to = target === '' ? [] : target.split('/');
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  const parts: string[] = [];
  for (let i = common; i < from.length; i++) parts.push('..');
  for (let i = common; i < to.length; i++) parts.push(to[i]);
  if (parts.length === 0) return '.';
  return parts[0] === '..' ? parts.join('/') : `./${parts.join('/')}`;
}

/** Split a URL into its path part and the `#anchor`/`?query` suffix (verbatim). */
function splitSuffix(url: string): { path: string; suffix: string } {
  const hash = url.indexOf('#');
  const query = url.indexOf('?');
  let cut = -1;
  if (hash !== -1 && query !== -1) cut = Math.min(hash, query);
  else if (hash !== -1) cut = hash;
  else if (query !== -1) cut = query;
  return cut === -1 ? { path: url, suffix: '' } : { path: url.slice(0, cut), suffix: url.slice(cut) };
}

/**
 * Build the old->new move map for relocating `from` to `to`. A `.md` source is a
 * single Concept; otherwise it is a folder (remap every Concept under it).
 */
function buildMoveMap(from: string, to: string): Map<string, string> {
  const map = new Map<string, string>();
  if (from.endsWith('.md')) {
    map.set(from, to);
    return map;
  }
  const prefix = `${from}/`;
  for (const path of conceptPaths()) {
    if (path.startsWith(prefix)) map.set(path, `${to}/${path.slice(prefix.length)}`);
  }
  return map;
}

/**
 * Rewrite the links in one Concept's `content`. `oldSource` is the source's
 * pre-move path (resolution base as authored); `newSource` is its post-move path
 * (used to re-resolve + recompute relative links). Returns the new content and
 * the count of links changed.
 */
function rewriteLinksIn(
  oldSource: string,
  newSource: string,
  content: string,
  moves: Map<string, string>,
): { content: string; count: number } {
  const moved = oldSource !== newSource;
  // Match `[text](inner)` but NOT images `![alt](src)`.
  const re = /(!?)(\[[^\]]*\]\()([^)]*)(\))/g;
  let count = 0;
  let out = content.replace(re, (whole, bang: string, open: string, inner: string, close: string) => {
    if (bang === '!') return whole; // image
    const rewritten = rewriteTarget(oldSource, newSource, moved, inner, moves);
    if (rewritten === null) return whole;
    count++;
    return `${open}${rewritten}${close}`;
  });
  const wiki = rewriteWikilinksIn(oldSource, out, moves);
  return { content: wiki.content, count: count + wiki.count };
}

/**
 * Old + new bundle path sets, used to resolve wikilinks before/after the move.
 * The "new" set is the current concept paths with the move map applied.
 */
function pathSetsFor(moves: Map<string, string>): { oldPaths: string[]; newPaths: string[] } {
  const oldPaths = conceptPaths();
  const newPaths = oldPaths.map((p) => moves.get(p) ?? p);
  return { oldPaths, newPaths };
}

/**
 * Shortest wikilink target that resolves to `newTarget` in the NEW bundle:
 * try the bare basename first, then progressively longer path suffixes, and
 * pick the first whose §1 resolution points back at `newTarget`. Falls back to
 * the full path if no shorter suffix resolves unambiguously.
 */
function shortestResolvingSuffix(newPaths: string[], newSource: string, newTarget: string): string {
  const noExt = newTarget.replace(/\.md$/i, '');
  const segs = noExt.split('/');
  for (let take = 1; take <= segs.length; take++) {
    const candidate = segs.slice(segs.length - take).join('/');
    const resolved = resolveWikilink(newPaths, newSource, candidate);
    if (resolved && resolved.path === newTarget) return candidate;
  }
  return noExt;
}

/**
 * Rewrite wikilinks (`[[ … ]]`, never embeds `![[ … ]]`) that target a moved
 * Concept (§4). Resolution is from the source's OLD location against the OLD
 * bundle; only links whose resolved target moved are rewritten:
 *   - BARE `[[old]]`: rewrites only when the target's basename changed (a pure
 *     folder move leaves it untouched, since bare names resolve bundle-wide);
 *   - PARTIAL PATH `[[a/old]]`: rewrites to the shortest suffix that resolves to
 *     the new path in the new bundle.
 * `|alias` and `#anchor` are preserved verbatim. Code regions are skipped.
 */
function rewriteWikilinksIn(
  oldSource: string,
  content: string,
  moves: Map<string, string>,
): { content: string; count: number } {
  const { oldPaths, newPaths } = pathSetsFor(moves);
  const newSource = moves.get(oldSource) ?? oldSource;
  const masked = maskCode(content);

  let count = 0;
  let result = '';
  let last = 0;
  let m: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(masked)) !== null) {
    if (m[1] === '!') continue; // embed (deferred)
    const start = m.index;
    const inner = m[2]; // same offsets in masked & original (length-preserving)
    const innerStart = start + m[1].length + 2; // after `(!?)[[`
    const origInner = content.slice(innerStart, innerStart + inner.length);

    const { name, alias, anchor } = splitWikilinkTarget(origInner);
    const resolved = resolveWikilink(oldPaths, oldSource, origInner);
    if (!resolved || !moves.has(resolved.path)) continue;
    const newTarget = moves.get(resolved.path)!;

    const nameTrimmed = name.trim();
    const isPartial = nameTrimmed.includes('/');
    let newName: string | null = null;
    if (isPartial) {
      newName = shortestResolvingSuffix(newPaths, newSource, newTarget);
    } else {
      // Bare name: only rewrite if the basename changed.
      const oldBase = resolved.path.replace(/\.md$/i, '').split('/').pop()!;
      const newBase = newTarget.replace(/\.md$/i, '').split('/').pop()!;
      if (oldBase !== newBase) newName = newBase;
    }
    if (newName === null) continue; // no change needed

    // Reassemble inner text, preserving alias/anchor verbatim.
    const anchorPart = anchor !== null ? `#${anchor}` : '';
    const aliasPart = alias !== null ? `|${alias}` : '';
    const newInner = `${newName}${anchorPart}${aliasPart}`;
    if (newInner === origInner) continue;

    result += content.slice(last, innerStart) + newInner;
    last = innerStart + inner.length;
    count++;
  }
  result += content.slice(last);
  return { content: result, count };
}

/**
 * Decide whether a link's inner parens text targets a moved Concept and, if so,
 * return the rewritten inner text (new target; anchor/query/title preserved).
 * `null` means leave unchanged.
 */
function rewriteTarget(
  oldSource: string,
  newSource: string,
  moved: boolean,
  inner: string,
  moves: Map<string, string>,
): string | null {
  const leadingWs = inner.length - inner.trimStart().length;
  const leading = inner.slice(0, leadingWs);
  const rest = inner.slice(leadingWs);

  const wsIdx = rest.search(/\s/);
  const urlRaw = wsIdx === -1 ? rest : rest.slice(0, wsIdx);
  const title = wsIdx === -1 ? '' : rest.slice(wsIdx);
  if (urlRaw === '') return null;

  let angleOpen = '';
  let angleClose = '';
  let urlCore = urlRaw;
  if (urlRaw.startsWith('<') && urlRaw.endsWith('>')) {
    angleOpen = '<';
    angleClose = '>';
    urlCore = urlRaw.slice(1, -1);
  }

  if (isExternalLink(urlCore) || urlCore.startsWith('#')) return null;

  const { path: pathPart, suffix } = splitSuffix(urlCore);
  if (pathPart === '') return null;

  const isAbsolute = pathPart.startsWith('/');

  // Resolve as authored, from the source's ORIGINAL location.
  const resolved = resolveLink(oldSource, pathPart);
  if (resolved.kind !== 'internal') return null;

  const targetMoved = moves.has(resolved.path);
  const newTarget = moves.get(resolved.path) ?? resolved.path;

  if (isAbsolute) {
    if (!targetMoved) return null;
  } else if (!targetMoved && !moved) {
    return null;
  }

  const newPath = isAbsolute ? `/${newTarget}` : relativePath(dirOf(newSource), newTarget);
  if (newPath === pathPart) return null;

  return `${leading}${angleOpen}${newPath}${suffix}${angleClose}${title}`;
}

/**
 * Auto-rewrite links for a move of `from`->`to`, planned against the in-memory
 * FILES. Reads content BEFORE the rename (snapshot), so callers MUST call this
 * BEFORE mutating FILES with the rename. Returns the rewrite summary and a map
 * of new-path -> rewritten content to apply AFTER the rename.
 */
export function planRewrites(from: string, to: string): {
  summary: RewriteSummary;
  writes: Map<string, string>;
} {
  const moves = buildMoveMap(from, to);
  const writes = new Map<string, string>();
  let linksChanged = 0;
  let filesChanged = 0;
  if (moves.size === 0) return { summary: { linksChanged, filesChanged }, writes };

  // Candidate sources: every Concept (cheap for the fixture) — inbound linkers
  // plus the moved files themselves. plan only emits writes for real changes.
  const sources = new Set<string>(conceptPaths());
  for (const old of moves.keys()) sources.add(old);

  for (const oldSource of [...sources].sort()) {
    const content = FILES[oldSource];
    if (content === undefined) continue;
    const newSource = moves.get(oldSource) ?? oldSource;
    const { content: rewritten, count } = rewriteLinksIn(oldSource, newSource, content, moves);
    if (count > 0) {
      linksChanged += count;
      filesChanged++;
      writes.set(newSource, rewritten);
    }
  }
  return { summary: { linksChanged, filesChanged }, writes };
}
