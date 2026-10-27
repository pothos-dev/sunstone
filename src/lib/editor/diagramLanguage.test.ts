// Unit tests for the pure diagram-language seam (dr-1, ADR-0014): language
// lookup by info string, the language-aware cache key, the lazy-loader memo
// and the class names every surface builds from.
import { describe, expect, test } from 'bun:test';
import {
  diagramCacheKey,
  diagramClasses,
  findDiagramLanguage,
  identity,
  languageCacheKey,
  rendererFor,
  type DiagramLanguage,
  type DiagramRenderer,
} from './diagramLanguage';
import { DIAGRAM_LANGUAGES } from './diagramLanguages';

/** A fake language whose loader counts its calls. */
function fakeLanguage(id: string): DiagramLanguage & { loads: number } {
  const lang = {
    id,
    loads: 0,
    sanitise: identity,
    load: async (): Promise<DiagramRenderer> => {
      lang.loads++;
      return async ({ source }) => `<svg>${source}</svg>`;
    },
  };
  return lang;
}

describe('findDiagramLanguage', () => {
  const a = fakeLanguage('alpha');
  const b = fakeLanguage('beta');

  test('finds the language named by the info string', () => {
    expect(findDiagramLanguage([a, b], 'beta')).toBe(b);
  });

  test('matches trimmed and case-insensitively', () => {
    expect(findDiagramLanguage([a, b], '  Alpha ')).toBe(a);
  });

  test('undefined for an unregistered or empty info string', () => {
    expect(findDiagramLanguage([a, b], 'python')).toBeUndefined();
    expect(findDiagramLanguage([a, b], '')).toBeUndefined();
  });

  test('mermaid is registered', () => {
    expect(findDiagramLanguage(DIAGRAM_LANGUAGES, 'mermaid')?.id).toBe('mermaid');
  });

  test('d2 is registered, sanitised and themed by its stylesheet', () => {
    const d2 = findDiagramLanguage(DIAGRAM_LANGUAGES, 'D2');
    expect(d2?.id).toBe('d2');
    expect(d2?.sanitise).not.toBe(identity);
    expect(d2?.themedByStylesheet).toBe(true);
    expect(d2?.stylesheet).toContain('.fill-N1');
  });

  test('plantuml is registered, sanitised, and themed at render time', () => {
    const plantuml = findDiagramLanguage(DIAGRAM_LANGUAGES, 'PlantUML');
    expect(plantuml?.id).toBe('plantuml');
    expect(plantuml?.sanitise).not.toBe(identity);
    expect(plantuml?.themedByStylesheet).toBeFalsy();
  });
});

describe('diagramCacheKey', () => {
  test('identical language + source + theme yields the same key', () => {
    expect(diagramCacheKey('mermaid', 'graph TD', 'light')).toBe(
      diagramCacheKey('mermaid', 'graph TD', 'light'),
    );
  });

  test('the same source in two languages never shares an entry', () => {
    expect(diagramCacheKey('mermaid', 'a -> b', 'light')).not.toBe(
      diagramCacheKey('d2', 'a -> b', 'light'),
    );
  });

  test('a theme flip or a source change yields a different key', () => {
    const key = diagramCacheKey('mermaid', 'graph TD', 'light');
    expect(diagramCacheKey('mermaid', 'graph TD', 'dark')).not.toBe(key);
    expect(diagramCacheKey('mermaid', 'graph LR', 'light')).not.toBe(key);
  });

  test('language and theme tokens cannot collide with source text', () => {
    expect(diagramCacheKey('d2', 'light x', 'dark')).not.toBe(
      diagramCacheKey('d2', 'x', 'light'),
    );
  });
});

describe('languageCacheKey', () => {
  test('a language that bakes its theme keys on the theme', () => {
    const lang = fakeLanguage('baked');
    expect(languageCacheKey(lang, 'x', 'light')).toBe(diagramCacheKey('baked', 'x', 'light'));
    expect(languageCacheKey(lang, 'x', 'dark')).toBe(diagramCacheKey('baked', 'x', 'dark'));
  });

  test('a stylesheet-themed language shares one entry across themes', () => {
    const lang = { ...fakeLanguage('styled'), themedByStylesheet: true };
    expect(languageCacheKey(lang, 'x', 'dark')).toBe(languageCacheKey(lang, 'x', 'light'));
    expect(languageCacheKey(lang, 'y', 'dark')).not.toBe(languageCacheKey(lang, 'x', 'dark'));
  });
});

describe('rendererFor', () => {
  test('loads the engine on first use only, and once', async () => {
    const lang = fakeLanguage('lazy-once');
    expect(lang.loads).toBe(0);
    const [r1, r2] = await Promise.all([rendererFor(lang), rendererFor(lang)]);
    expect(r1).toBe(r2);
    await rendererFor(lang);
    expect(lang.loads).toBe(1);
    expect(await r1({ source: 'x', theme: 'light', read: () => '', renderId: 'r' })).toBe(
      '<svg>x</svg>',
    );
  });

  test("never loads a language that is not asked for", async () => {
    const used = fakeLanguage('lazy-used');
    const unused = fakeLanguage('lazy-unused');
    await rendererFor(used);
    expect(unused.loads).toBe(0);
  });
});

describe('diagramClasses', () => {
  test('a generic class plus the language class, per surface', () => {
    expect(diagramClasses('cm', 'mermaid')).toBe('cm-diagram cm-mermaid');
    expect(diagramClasses('web', 'mermaid', 'render')).toBe('web-diagram-render web-mermaid-render');
    expect(diagramClasses('cm', 'd2', 'error-message')).toBe(
      'cm-diagram-error-message cm-d2-error-message',
    );
  });
});
