import { describe, expect, test } from 'bun:test';
import type { RenderPayload, TreeNode } from '$lib/types';
import { crawlerFile, llmsTxt, pageMeta, robotsTxt, siteName, sitemapXml, type ConceptSummary } from './seo';

const ORIGIN = 'https://wiki.example.org';

function rendered(fm: Record<string, string>): RenderPayload {
  return {
    html: '',
    frontmatter: Object.entries(fm).map(([key, v]) => ({ key, values: [v] })),
    outline: [],
    trust: null,
    sourceCount: 0,
  } as unknown as RenderPayload;
}

function summary(path: string, extra: Partial<ConceptSummary> = {}): ConceptSummary {
  return { path, title: null, description: null, type: null, tags: null, timestamp: null, ...extra };
}

describe('crawlerFile', () => {
  test('names only the three root files', () => {
    expect(crawlerFile('/robots.txt')).toBe('robots.txt');
    expect(crawlerFile('/sitemap.xml')).toBe('sitemap.xml');
    expect(crawlerFile('/llms.txt')).toBe('llms.txt');
    expect(crawlerFile('/docs/robots.txt')).toBeNull();
    expect(crawlerFile('/robots')).toBeNull();
  });
});

describe('siteName', () => {
  test('is the root index title', () => {
    const tree: TreeNode = {
      name: 'b',
      path: '',
      isDir: true,
      children: [
        { name: 'a', path: 'a', isDir: true, children: [] },
        { name: 'index.md', path: 'index.md', isDir: false, title: ' Guide ' },
      ],
    };
    expect(siteName(tree)).toBe('Guide');
  });

  test('is null without a titled root index', () => {
    expect(siteName({ name: 'b', path: '', isDir: true, children: [] })).toBeNull();
    const untitled: TreeNode = {
      name: 'b',
      path: '',
      isDir: true,
      children: [{ name: 'index.md', path: 'index.md', isDir: false }],
    };
    expect(siteName(untitled)).toBeNull();
  });
});

describe('pageMeta', () => {
  test('a Concept: title with the site name, description, pretty canonical URL', () => {
    const meta = pageMeta({
      origin: ORIGIN,
      selected: 'editing/links.md',
      rendered: rendered({ title: 'Links', description: '  Wikilinks.  ' }),
      pageTitle: 'Links',
      siteName: 'Guide',
    });
    expect(meta).toEqual({ title: 'Links · Guide', description: 'Wikilinks.', canonical: `${ORIGIN}/editing/links` });
  });

  test('a folder index is canonical at the folder URL', () => {
    const meta = pageMeta({ origin: ORIGIN, selected: 'editing/index.md', rendered: null, pageTitle: 'Editing', siteName: null });
    expect(meta).toEqual({ title: 'Editing', description: null, canonical: `${ORIGIN}/editing` });
  });

  test('the root page does not repeat the site name', () => {
    const meta = pageMeta({ origin: ORIGIN, selected: 'index.md', rendered: null, pageTitle: 'Guide', siteName: 'Guide' });
    expect(meta.title).toBe('Guide');
    expect(meta.canonical).toBe(`${ORIGIN}/`);
  });

  test('nothing open: no canonical URL', () => {
    const meta = pageMeta({ origin: ORIGIN, selected: null, rendered: null, pageTitle: 'Sunstone Web', siteName: null });
    expect(meta.canonical).toBeNull();
  });
});

describe('robotsTxt', () => {
  test('allows everything and names the sitemap', () => {
    expect(robotsTxt(ORIGIN)).toBe(`User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
  });
});

describe('sitemapXml', () => {
  test('one url per Concept, lastmod only from a dated timestamp, escaped', () => {
    const xml = sitemapXml(ORIGIN, [
      summary('index.md', { timestamp: '2026-01-02T10:00:00Z' }),
      summary('a/index.md', { timestamp: 'yesterday' }),
      summary('a/b & c.md'),
    ]);
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        `  <url><loc>${ORIGIN}/</loc><lastmod>2026-01-02</lastmod></url>\n` +
        `  <url><loc>${ORIGIN}/a</loc></url>\n` +
        `  <url><loc>${ORIGIN}/a/b%20%26%20c</loc></url>\n` +
        '</urlset>\n',
    );
  });

  test('an empty Bundle is an empty urlset', () => {
    expect(sitemapXml(ORIGIN, [])).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>');
  });
});

describe('llmsTxt', () => {
  test('heads with the root Concept and lists every page', () => {
    const txt = llmsTxt(ORIGIN, [
      summary('index.md', { title: 'Guide', description: 'All about\nit.' }),
      summary('a/b.md', { title: 'B', description: 'The b page.' }),
      summary('c.md'),
    ]);
    expect(txt.split('\n').slice(0, 3)).toEqual(['# Guide', '', '> All about it.']);
    expect(txt).toContain('`Accept: text/markdown`');
    expect(txt).toContain(`- [Guide](${ORIGIN}/): All about it.\n`);
    expect(txt).toContain(`- [B](${ORIGIN}/a/b): The b page.\n`);
    expect(txt).toContain(`- [/c](${ORIGIN}/c)\n`);
  });

  test('falls back to the host without a root index', () => {
    expect(llmsTxt(ORIGIN, []).startsWith('# wiki.example.org\n')).toBe(true);
  });
});
