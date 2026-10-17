// Unit tests for the generic diagram fence detection (dr-1, ADR-0014): a fence
// is matched to its registered language, other languages' fences and plain
// code are ignored. Mermaid-specific cases live in `mermaidBlocks.test.ts`.
import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { findDiagramBlocks } from './diagramBlocks';
import { identity, type DiagramLanguage } from './diagramLanguage';
import { mermaidLanguage } from './mermaidLanguage';

function stateOf(doc: string) {
  return EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
}

const d2: DiagramLanguage = {
  id: 'd2',
  sanitise: identity,
  load: () => Promise.reject(new Error('never loaded by detection')),
};
const LANGS = [mermaidLanguage, d2];
const PARSE = 0;

describe('findDiagramBlocks', () => {
  test('tags each fence with its language', () => {
    const doc = '```mermaid\ngraph TD\n```\n\n```d2\na -> b\n```';
    const blocks = findDiagramBlocks(stateOf(doc), LANGS, PARSE);
    expect(blocks.map((b) => [b.language.id, b.source])).toEqual([
      ['mermaid', 'graph TD'],
      ['d2', 'a -> b'],
    ]);
  });

  test('ignores fences of unregistered languages', () => {
    const doc = '```d2\na -> b\n```\n\n```python\nx\n```';
    expect(findDiagramBlocks(stateOf(doc), [mermaidLanguage], PARSE)).toEqual([]);
  });

  test('defaults to the registry, which holds mermaid', () => {
    const blocks = findDiagramBlocks(stateOf('```mermaid\nA\n```'), undefined, PARSE);
    expect(blocks.map((b) => b.language.id)).toEqual(['mermaid']);
  });
});
