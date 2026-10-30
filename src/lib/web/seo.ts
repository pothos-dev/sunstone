// What Sunstone Web tells search engines and AI crawlers (pure; no DOM/IPC):
// the per-page `<head>` tags and the three crawler files the SSR hook serves
// at the site root, `/robots.txt`, `/sitemap.xml` and `/llms.txt`.
//
// A Sunstone Web that is reachable from the internet is public, so all of it is
// crawlable; a private wiki is kept private on the network, not by robots.txt.

import type { RenderPayload, TreeNode } from '$lib/types';
import { conceptToUrl } from '$lib/wasm/exports';

/**
 * Response header a page `load` sets when the URL names no Concept. The hook
 * (`hooks.server.ts`) strips it and answers `404`, so the shell still renders
 * but crawlers do not index the miss as a page.
 */
export const NOT_FOUND_HEADER = 'x-sunstone-not-found';

/** One `GET /?list` entry of the content API (absent fields are `null`). */
export interface ConceptSummary {
  path: string;
  title: string | null;
  description: string | null;
  type: string | null;
  tags: string[] | null;
  timestamp: string | null;
}

/** The crawler file a root pathname names, or `null`. */
export type CrawlerFile = 'robots.txt' | 'sitemap.xml' | 'llms.txt';

export function crawlerFile(pathname: string): CrawlerFile | null {
  if (pathname === '/robots.txt' || pathname === '/sitemap.xml' || pathname === '/llms.txt') {
    return pathname.slice(1) as CrawlerFile;
  }
  return null;
}

/** The first value of a frontmatter key in a rendered Concept, trimmed, or `null`. */
function frontmatterValue(rendered: RenderPayload | null, key: string): string | null {
  const v = rendered?.frontmatter.find((f) => f.key.toLowerCase() === key)?.values[0]?.trim();
  return v || null;
}

/** The site's name: the root `index.md`'s title in the Explorer tree, or `null`. */
export function siteName(tree: TreeNode): string | null {
  return tree.children?.find((c) => !c.isDir && c.path === 'index.md')?.title?.trim() || null;
}

/** The `<head>` facts for one page. */
export interface PageMeta {
  /** The document title: `<page> · <site>`, or just one of them. */
  title: string;
  /** The Concept's frontmatter `description`, or `null`. */
  description: string | null;
  /** The absolute pretty URL of the Concept, or `null` when none is open. */
  canonical: string | null;
}

/**
 * The `<head>` facts for the page showing `selected`. `pageTitle` is the
 * Concept's own title (`conceptUrl.pageTitle`); `siteName` is the root
 * `index.md`'s title, appended unless this is the root page itself.
 */
export function pageMeta(opts: {
  origin: string;
  selected: string | null;
  rendered: RenderPayload | null;
  pageTitle: string;
  siteName: string | null;
}): PageMeta {
  const { origin, selected, rendered, pageTitle, siteName } = opts;
  const isRoot = selected === 'index.md';
  const title = siteName && !isRoot && siteName !== pageTitle ? `${pageTitle} · ${siteName}` : pageTitle;
  return {
    title,
    description: frontmatterValue(rendered, 'description'),
    canonical: selected === null ? null : origin + conceptToUrl(selected),
  };
}

/** `robots.txt`: everything is crawlable; points at the sitemap. */
export function robotsTxt(origin: string): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;
}

/** `YYYY-MM-DD` from a frontmatter timestamp, or `null` when it is not a date. */
function lastmod(timestamp: string | null): string | null {
  const m = timestamp?.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** `sitemap.xml`: one `<url>` per Concept, `<lastmod>` from its `timestamp`. */
export function sitemapXml(origin: string, concepts: readonly ConceptSummary[]): string {
  const urls = concepts.map((c) => {
    const mod = lastmod(c.timestamp);
    const loc = `<loc>${xmlEscape(origin + conceptToUrl(c.path))}</loc>`;
    return `  <url>${loc}${mod ? `<lastmod>${mod}</lastmod>` : ''}</url>`;
  });
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join('\n') +
    (urls.length ? '\n' : '') +
    '</urlset>\n'
  );
}

/** A one-line Markdown text: newlines folded, so a value cannot break the list. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** A Concept's label: its title, else its pretty URL. */
function label(c: ConceptSummary): string {
  return oneLine(c.title ?? '') || conceptToUrl(c.path);
}

/**
 * `llms.txt` (https://llmstxt.org): the root `index.md`'s title and
 * description, how to fetch a page as Markdown, and every Concept with its
 * description.
 */
export function llmsTxt(origin: string, concepts: readonly ConceptSummary[]): string {
  const root = concepts.find((c) => c.path === 'index.md');
  const lines = [`# ${root?.title ? oneLine(root.title) : new URL(origin).host}`, ''];
  if (root?.description) lines.push(`> ${oneLine(root.description)}`, '');
  lines.push(
    'Every page is also available as Markdown: request its URL with `Accept: text/markdown`. ' +
      'With `Accept: application/json` it answers frontmatter, body, links and backlinks.',
    '',
    '## Pages',
    '',
  );
  for (const c of concepts) {
    const desc = c.description ? `: ${oneLine(c.description)}` : '';
    lines.push(`- [${label(c)}](${origin}${conceptToUrl(c.path)})${desc}`);
  }
  return lines.join('\n') + '\n';
}
