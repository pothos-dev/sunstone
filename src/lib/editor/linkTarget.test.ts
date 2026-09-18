import { describe, test, expect } from 'bun:test';
import { markdownLanguage } from '@codemirror/lang-markdown';
import type { SyntaxNode } from '@lezer/common';
import { destinationUrlNode } from './linkTarget';

/** Parse `doc` and return its first `Link` node. */
function firstLink(doc: string): SyntaxNode {
  const tree = markdownLanguage.parser.parse(doc);
  const cursor = tree.cursor();
  do {
    if (cursor.name === 'Link') return cursor.node;
  } while (cursor.next());
  throw new Error(`no Link node in ${JSON.stringify(doc)}`);
}

/** The destination URL of the first link in `doc`, as source text. */
function destination(doc: string): string | null {
  const url = destinationUrlNode(firstLink(doc));
  return url ? doc.slice(url.from, url.to) : null;
}

describe('destinationUrlNode', () => {
  test('a plain link resolves to its destination', () => {
    expect(destination('see [CodeMirror](./codemirror.md) here')).toBe('./codemirror.md');
  });

  test('an autolinked EMAIL label does not shadow the destination', () => {
    // GFM autolinks `a@b.co` inside the label into a `URL` node of its own, so
    // the Link has two `URL` children and the first one is the LABEL.
    expect(destination('mail [a@b.co](mailto:a@b.co) us')).toBe('mailto:a@b.co');
  });

  test('an autolinked URL label does not shadow the destination', () => {
    expect(destination('[https://example.com](https://example.com/docs)')).toBe(
      'https://example.com/docs',
    );
  });

  test('a link title after the destination does not shadow it', () => {
    expect(destination('[a@b.co](mailto:a@b.co "Write us")')).toBe('mailto:a@b.co');
  });

  test('a bracketed span with no destination has none', () => {
    // An OKF citation marker `[1]`, and a label that autolinks on its own.
    expect(destination('cited [1] here')).toBeNull();
    expect(destination('plain [a@b.co] text')).toBeNull();
  });
});
