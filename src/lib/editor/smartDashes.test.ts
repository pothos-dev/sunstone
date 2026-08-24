import { describe, expect, test } from 'bun:test';
import { findSmartDashes } from './smartDashes';

/** Render `text` with the found dashes applied, for readable assertions. */
function apply(text: string): string {
  let out = '';
  let pos = 0;
  for (const run of findSmartDashes(text)) {
    out += text.slice(pos, run.from) + run.dash;
    pos = run.to;
  }
  return out + text.slice(pos);
}

describe('findSmartDashes', () => {
  test('renders -- as an en-dash', () => {
    expect(apply('pages 10--20')).toBe('pages 10–20');
  });

  test('renders --- as an em-dash', () => {
    expect(apply('one thing --- another')).toBe('one thing — another');
  });

  test('handles multiple runs on one line', () => {
    expect(apply('a--b and c---d')).toBe('a–b and c—d');
  });

  test('reports correct offsets across lines', () => {
    const runs = findSmartDashes('x\nab--cd\n');
    expect(runs).toEqual([{ from: 4, to: 6, dash: '–' }]);
  });

  test('leaves single hyphens alone', () => {
    expect(apply('well-known')).toBe('well-known');
  });

  test('leaves runs of 4+ hyphens alone', () => {
    expect(apply('a ---- b')).toBe('a ---- b');
  });

  test('skips thematic breaks', () => {
    expect(apply('above\n---\nbelow')).toBe('above\n---\nbelow');
  });

  test('skips setext underlines and long rules', () => {
    expect(apply('Heading\n-------\n')).toBe('Heading\n-------\n');
  });

  test('skips table delimiter rows but not table content', () => {
    const table = '| a | b |\n| --- | :--- |\n| 1--2 | x |';
    expect(apply(table)).toBe('| a | b |\n| --- | :--- |\n| 1–2 | x |');
  });

  test('skips fenced code blocks', () => {
    const md = '```\na--b\n```\nc--d';
    expect(apply(md)).toBe('```\na--b\n```\nc–d');
  });

  test('tilde fences do not close backtick fences', () => {
    const md = '```\n~~~\na--b\n```\nc--d';
    expect(apply(md)).toBe('```\n~~~\na--b\n```\nc–d');
  });

  test('skips inline code spans', () => {
    expect(apply('use `--flag` here--there')).toBe('use `--flag` here–there');
  });

  test('skips HTML comment delimiters', () => {
    expect(apply('<!-- note -->')).toBe('<!-- note -->');
    expect(apply('<!-- a--b -->')).toBe('<!-- a–b -->');
  });
});
