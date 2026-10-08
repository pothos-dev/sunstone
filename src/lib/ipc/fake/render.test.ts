import { describe, expect, test } from 'bun:test';
import { renderConcept } from './render';

// ov-9: the trust line opens the body, like the native render.
describe('renderConcept trust line', () => {
  test('a Concept with trust keys starts with the trust line', () => {
    const { html } = renderConcept('---\ntype: x\nverified: { by: human:a }\n---\n\n# T\n');
    expect(html.startsWith('<div class="trust trust-human-reviewed" data-testid="trust">')).toBe(true);
  });

  test('a Concept without them renders as before', () => {
    const { html } = renderConcept('---\ntype: x\n---\n\n# T\n');
    expect(html).not.toContain('class="trust');
  });
});

// The fake renderer is a minimal stand-in for the Rust core, but it must emit
// the SAME citation markup so the web viewer / Playwright path matches export.
describe('renderConcept citations', () => {
  test('inline references become superscript links', () => {
    const { html } = renderConcept('deepen umami and body.[6][7][8]\n');
    // The `[n]` brackets are kept around the clickable number.
    expect(html).toContain('<sup class="citation-ref"><a href="#cite-6">[6]</a></sup>');
    expect(html).toContain('href="#cite-7">[7]<');
    expect(html).toContain('href="#cite-8">[8]<');
    // The bracketed number only appears inside the superscript anchor, never as
    // a stray bare token alongside it.
    expect(html).not.toContain('</a></sup>[7]');
  });

  test('a citation-table row is a literal, anchored (non-superscript) target', () => {
    const { html } = renderConcept('body.[6]\n\n[6] Kokumi source.\n');
    expect(html).toContain('<a id="cite-6" class="citation-def">[6]</a>');
    expect(html).not.toContain('<sup class="citation-ref"><a href="#cite-6">[6]</a></sup> Kokumi');
  });

  test('a space-preceded bracketed number is left alone', () => {
    const { html } = renderConcept('a paragraph [6] mid-sentence\n');
    expect(html).toContain('[6]');
    expect(html).not.toContain('citation-ref');
    expect(html).not.toContain('citation-def');
  });
});

// Footnotes must match the Rust `footnotes_to_sentinels` markup (ov-14).
describe('renderConcept footnotes', () => {
  test('a reference links to its definition, numbered by first use', () => {
    const { html } = renderConcept('Claim [^2] here.\n\n[^2]: The source.\n');
    expect(html).toContain(
      'Claim <sup class="footnote-ref" title="2"><a href="#fn-2">1</a></sup> here.',
    );
    expect(html).toContain('<p><a id="fn-2" class="footnote-def" title="2">1</a> The source.</p>');
  });

  test('a sources id links the reference to its resource, with no body definition', () => {
    const { html } = renderConcept(
      '---\ntype: N\nsources:\n  - id: ssi-web\n    resource: https://x\n    title: SSI\n  - id: all\n    resource: all queries in X\n  - id: unused\n    resource: /u.md\n---\n\nA[^b] B[^ssi-web][^all]\n\n[^b]: B\n',
    );
    expect(html).toContain('A<sup class="footnote-ref" title="b"><a href="#fn-b">1</a></sup>');
    // Each source element carries its entry as JSON for the hover card.
    const d = (
      id: string | null,
      resource: string,
      kind: string,
      title: string | null,
      index: number,
      refs: number[],
      num: number | null,
    ) =>
      'data-source="' +
      JSON.stringify({
        id,
        resource,
        kind,
        title,
        author: null,
        usageCount: null,
        lastModified: null,
        usageWindow: null,
        index,
        note: null,
        refs,
        num,
      })
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;') +
      '"';
    const ssi = d('ssi-web', 'https://x', 'url', 'SSI', 0, [8], 2);
    const all = d('all', 'all queries in X', 'descriptor', null, 1, [18], 3);
    const unused = d('unused', '/u.md', 'path', null, 2, [], null);
    expect(html).toContain(
      `B<sup id="fnref-ssi-web-1" class="footnote-ref source" ${ssi}><a href="https://x">2</a></sup>`,
    );
    expect(html).toContain(`<sup id="fnref-all-1" class="footnote-ref source" ${all}>,3</sup>`);
    const back = (id: string) =>
      `<span class="source-backrefs"><a class="source-backref" href="#fnref-${id}-1" title="Jump to citation 1">↑</a></span>`;
    // The Sources section closes the body: cited by number, then uncited.
    expect(html).toContain(
      '<section class="sources"><div class="sources-heading">Sources</div><ol class="sources-list">' +
        `<li><span class="source-num">2</span><span class="source-body"><a href="https://x" ${ssi}><span class="source-title">SSI</span></a><span class="source-resource">https://x</span>${back('ssi-web')}</span></li>` +
        `<li><span class="source-num">3</span><span class="source-body"><span class="source-title" ${all}>all queries in X</span>${back('all')}</span></li>` +
        `<li><span class="source-num"></span><span class="source-body"><a href="/u.md" ${unused}><span class="source-title">/u.md</span></a></span></li>` +
        '</ol></section>',
    );
  });

  test('entries show signals, a body definition and every citing place (Rust markup)', () => {
    const { html } = renderConcept(
      '---\ntype: N\nsources:\n  - id: s\n    resource: https://s\n    author: human:dan\n    usage_count: 7\n    last_modified: 2026-05-30\nusage_window: { from: 2026-06-01, to: 2026-06-30 }\n---\n\nA[^s] B[^s]\n\n[^s]: Written by hand\n',
    );
    const [text, section] = html.split('<section class="sources">');
    // The definition line is gone from the body; its text sits on the entry.
    expect(text).not.toContain('hand</p>');
    expect(text).not.toContain('footnote-def');
    expect(text).toContain('B<sup id="fnref-s-2" class="footnote-ref source"');
    expect(section).toContain(
      '<span class="source-signals">' +
        '<span class="source-signal"><span class="source-signal-key">Author</span> <span class="actor actor-human" title="Person: dan"><span class="actor-kind">person</span><span class="actor-id">dan</span></span></span>' +
        '<span class="source-signal"><span class="source-signal-key">Last modified</span> 2026-05-30</span>' +
        '<span class="source-signal"><span class="source-signal-key">Usage count</span> 7 (2026-06-01 – 2026-06-30)</span>' +
        '</span><span class="source-note">Written by hand</span>' +
        '<span class="source-backrefs">↑ <a class="source-backref" href="#fnref-s-1" title="Jump to citation 1">a</a> <a class="source-backref" href="#fnref-s-2" title="Jump to citation 2">b</a></span>',
    );
  });

  test('a v0.1 `# Citations` list and its `[n]` references still render', () => {
    const { html } = renderConcept('Revenue grew.[1]\n\n# Citations\n\n[1] Annual report\n');
    expect(html).toContain('<sup class="citation-ref"><a href="#cite-1">[1]</a></sup>');
    expect(html).toContain('<a id="cite-1" class="citation-def">[1]</a> Annual report');
    expect(html).not.toContain('class="sources"');
  });

  test('no sources, no Sources section', () => {
    expect(renderConcept('x[^1]\n\n[^1]: one\n').html).not.toContain('sources');
  });

  test('a reference with no definition is broken and unlinked', () => {
    const { html } = renderConcept('Claim[^9].\n');
    expect(html).toContain('<sup class="footnote-ref broken" title="9">1</sup>');
    expect(html).not.toContain('#fn-9');
  });

  test('mixed-case labels share one lowercased anchor', () => {
    const { html } = renderConcept('x[^Src]\n\n[^src]: s\n');
    expect(html).toContain('<a href="#fn-src">1</a>');
    expect(html).toContain('<a id="fn-src" class="footnote-def" title="src">1</a>');
  });

  test('citations and footnotes render side by side', () => {
    const { html } = renderConcept('a.[6] b[^1]\n\n[6] row\n[^1]: note\n');
    expect(html).toContain('href="#cite-6"');
    expect(html).toContain('href="#fn-1"');
  });

  test('a footnote in Embed alt text neither renders nor counts (ov-18)', () => {
    const { html } = renderConcept('![chart[^a]](x.png) text[^b]\n');
    expect(html).toContain('text<sup class="footnote-ref broken" title="b">1</sup>');
    expect(html).not.toContain('title="a"');
  });

  test('numeric labels number by first use', () => {
    const { html } = renderConcept('A[^21] B[^2]\n');
    expect(html).toContain('A<sup class="footnote-ref broken" title="21">1</sup>');
    expect(html).toContain('B<sup class="footnote-ref broken" title="2">2</sup>');
  });

  test('a footnote in a heading still renders', () => {
    const { html } = renderConcept('# Title[^1]\n\n[^1]: n\n');
    expect(html).toContain('Title<sup class="footnote-ref" title="1"><a href="#fn-1">1</a></sup></h1>');
  });

  test('a definition inside a fenced block is left alone (ov-16)', () => {
    const { html } = renderConcept('x[^1]\n\n```\n[^1]: in code\ny[^1]\n```\n');
    expect(html).not.toContain('footnote-def');
    expect(html).toContain('<p>[^1]: in code</p>');
    expect(html).toContain('<p>y[^1]</p>');
    expect(html).toContain('x<sup class="footnote-ref broken" title="1">1</sup>');
  });

  test('only the first definition of a label owns the anchor (ov-16)', () => {
    const { html } = renderConcept('x[^a]\n\n[^a]: one\n\n[^A]: two\n');
    expect(html.match(/id="fn-a"/g)?.length).toBe(1);
    expect(html).toContain('<a id="fn-a" class="footnote-def" title="a">1</a> one');
    expect(html).toContain('<a class="footnote-def" title="A">1</a> two');
  });

  test('a footnote inside a CriticMarkup mark stays text', () => {
    const { html } = renderConcept('a {++b[^1]++} c[^2]\n');
    expect(html).toContain('<ins class="critic-add">b[^1]</ins>');
    expect(html).toContain('c<sup class="footnote-ref broken" title="2">2</sup>');
  });
});
