import { describe, expect, test } from 'bun:test';
import { renderConcept } from './render';

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

  test('a sources id resolves a reference with no body definition', () => {
    const { html } = renderConcept(
      '---\ntype: N\nsources:\n  - id: ssi-web\n    resource: https://x\n---\n\nA[^b] B[^ssi-web]\n\n[^b]: B\n',
    );
    expect(html).toContain('A<sup class="footnote-ref" title="b"><a href="#fn-b">1</a></sup>');
    expect(html).toContain('B<sup class="footnote-ref" title="ssi-web">2</sup>');
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
});
