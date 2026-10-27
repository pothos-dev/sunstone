// Unit tests for the engine-agnostic PlantUML half (dr-4). The fixtures are
// real `@plantuml/core` 1.2026.6 output.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatPlantUmlError,
  plantumlDiagramError,
  plantumlInput,
  renderPlantUml,
  svgTextLines,
  usesEmoji,
  type PlantUmlLike,
} from './plantumlEngine';

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8');

const PREAMBLE = ['<style>', 'root {', '  FontColor #111111', '}', '</style>'];

describe('plantumlInput', () => {
  test('inserts the preamble right after the @start line', () => {
    const input = plantumlInput("' a comment\n@startuml\nA -> B\n@enduml", PREAMBLE);
    expect(input.lines).toEqual(["' a comment", '@startuml', ...PREAMBLE, 'A -> B', '@enduml']);
    // Lines up to @startuml are unmoved; later ones shift by the preamble.
    expect(input.fenceLine(2)).toBe(2);
    expect(input.fenceLine(3 + PREAMBLE.length)).toBe(3);
  });

  test('keeps the diagram kind of any @start directive', () => {
    const input = plantumlInput('@startmindmap\n* root\n@endmindmap', PREAMBLE);
    expect(input.lines[0]).toBe('@startmindmap');
    expect(input.lines[1]).toBe('<style>');
  });

  test('wraps a bare body in @startuml/@enduml', () => {
    const input = plantumlInput('A -> B\r\nB -> C', PREAMBLE);
    expect(input.lines).toEqual(['@startuml', ...PREAMBLE, 'A -> B', 'B -> C', '@enduml']);
    expect(input.fenceLine(2 + PREAMBLE.length)).toBe(1);
    expect(input.fenceLine(3 + PREAMBLE.length)).toBe(2);
    // A line inside our own wrapping never maps below the fence.
    expect(input.fenceLine(1)).toBe(1);
  });
});

test('svgTextLines reads text in order and decodes entities', () => {
  const svg = '<svg><text x="1">A -&gt; B &amp; &#65;&#x42;</text><g><text>&lt;C&gt;</text></g></svg>';
  expect(svgTextLines(svg)).toEqual(['A -> B & AB', '<C>']);
});

describe('plantumlDiagramError', () => {
  test('a real diagram is not an error', () => {
    expect(plantumlDiagramError(fixture('plantuml-sequence.svg'))).toBeNull();
    expect(plantumlDiagramError('<svg></svg>')).toBeNull();
  });

  test("a syntax error: the engine's message at its line", () => {
    expect(plantumlDiagramError(fixture('plantuml-syntax-error.svg'))).toBe(
      'line 3: Syntax Error? (Assumed diagram type: sequence)',
    );
  });

  test('maps the line back through the preamble', () => {
    expect(plantumlDiagramError(fixture('plantuml-syntax-error.svg'), (n) => n - 1)).toBe(
      'line 2: Syntax Error? (Assumed diagram type: sequence)',
    );
  });

  test('a standard-library include fails with "cannot include"', () => {
    expect(plantumlDiagramError(fixture('plantuml-include-error.svg'))).toBe(
      'line 2: cannot include <C4/C4_Container>',
    );
  });

  test('an unknown directive names it', () => {
    expect(plantumlDiagramError(fixture('plantuml-not-supported.svg'))).toBe(
      'Diagram not supported by this release of PlantUML: Alice -> Bob : no start tag',
    );
  });

  test('an engine crash', () => {
    const svg = '<svg><text>An error has occurred : java.lang.NullPointerException</text><text> </text><text>more</text></svg>';
    expect(plantumlDiagramError(svg)).toBe('An error has occurred : java.lang.NullPointerException\nmore');
  });
});

test('formatPlantUmlError drops the Java exception class', () => {
  expect(formatPlantUmlError('java.lang.RuntimeException: Failed to load emoji.js')).toBe(
    'Failed to load emoji.js',
  );
  expect(formatPlantUmlError('plain message')).toBe('plain message');
});

describe('renderPlantUml', () => {
  /** An engine that answers with `svg` (or fails with `error`) and records its input. */
  function stubEngine(answer: { svg?: string; error?: string; throws?: string }) {
    const seen: string[][] = [];
    const engine: PlantUmlLike = {
      renderToString(lines, onSuccess, onError) {
        seen.push(lines);
        if (answer.throws) throw new Error(answer.throws);
        setTimeout(() => (answer.error ? onError(answer.error) : onSuccess(answer.svg ?? '')), 1);
      },
    };
    return { engine, seen };
  }

  test('resolves with the SVG of a good source, rendered with the preamble', async () => {
    const svg = fixture('plantuml-sequence.svg');
    const { engine, seen } = stubEngine({ svg });
    await expect(renderPlantUml(engine, 'Alice -> Bob', PREAMBLE)).resolves.toBe(svg);
    expect(seen[0]).toEqual(['@startuml', ...PREAMBLE, 'Alice -> Bob', '@enduml']);
  });

  test('rejects with the message an error picture stands for, at the fence line', async () => {
    // The fixture reports engine line 3; with a one-line preamble after
    // `@startuml` that is fence line 2.
    const { engine } = stubEngine({ svg: fixture('plantuml-syntax-error.svg') });
    await expect(renderPlantUml(engine, '@startuml\nAlice -> :\n@enduml', ['x'])).rejects.toThrow(
      'line 2: Syntax Error? (Assumed diagram type: sequence)',
    );
  });

  test('rejects with the engine error, readable', async () => {
    const { engine } = stubEngine({ error: 'java.lang.RuntimeException: boom' });
    await expect(renderPlantUml(engine, 'A -> B', [])).rejects.toThrow(/^boom$/);
  });

  test('rejects when the engine throws synchronously', async () => {
    const { engine } = stubEngine({ throws: 'java.lang.IllegalStateException: busy' });
    await expect(renderPlantUml(engine, 'A -> B', [])).rejects.toThrow(/^busy$/);
  });
});

test('usesEmoji spots emoji, not icons or colours', () => {
  expect(usesEmoji('A -> B : <:smile:> hi')).toBe(true);
  expect(usesEmoji('A -> B : <#green:sunny:>')).toBe(true);
  expect(usesEmoji('A -> B : <&star> star')).toBe(false);
  expect(usesEmoji('class Foo #red')).toBe(false);
  expect(usesEmoji('A -> B : a:b')).toBe(false);
});
