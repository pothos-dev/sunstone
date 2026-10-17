// The diagram-language seam (dr-1, ADR-0014) — PURE, DOM- and CodeMirror-free.
//
// A Diagram (docs/GLOSSARY.md) is the rendered output of a fenced code block
// whose info string names a registered diagram language. Everything that is
// the same for every language (fence detection, the block-replace + reveal,
// double-click to edit, the hover hint, the loading placeholder, the error
// panel, the render cache, the stale-generation discard, the theme rebuild)
// lives ONCE in the generic half:
//
//   diagramLanguage.ts   this file: the `DiagramLanguage` contract, the
//                        lazy-loader memo, the cache key, the class names
//   diagramLanguages.ts  the registry — one line per language
//   diagramBlocks.ts     fence detection over the CodeMirror tree
//   diagramRender.ts     the DOM render engine (shared by editor + web)
//   diagram.ts           the CodeMirror StateField + block widget
//   web/webDiagram.ts    the web viewer / print hydration island
//
// A language contributes only a `DiagramLanguage` object (see
// `mermaidLanguage.ts`) and a line in `diagramLanguages.ts`.

/**
 * The app's resolved colour scheme (mirrors `state/theme.svelte.ts`'s
 * `ResolvedTheme`). Kept dependency-free so this module stays pure.
 */
export type ResolvedTheme = 'light' | 'dark';

/** Reads a resolved CSS custom-property value, e.g. `read('--bg')`. */
export type CssVarReader = (name: string) => string;

/** Everything a renderer gets for one diagram. */
export interface DiagramRenderRequest {
  /** The fence body, excluding the ``` lines. */
  readonly source: string;
  /** The resolved app theme the diagram is rendered for. */
  readonly theme: ResolvedTheme;
  /**
   * Reads the app's CSS custom properties off the themed root (the editor's
   * `view.dom`, the web island's root), for a language that bakes concrete
   * colours into its SVG.
   */
  readonly read: CssVarReader;
  /**
   * A string unique to this render (`<surface>-<language>-<n>`), usable as a
   * DOM id (mermaid needs one) or as a per-block id salt (D2's `salt`).
   */
  readonly renderId: string;
}

/**
 * Turns one diagram into an SVG string. Rejects (throws) on a bad source; the
 * rejection's `message` is shown in the error panel.
 */
export type DiagramRenderer = (request: DiagramRenderRequest) => Promise<string>;

/** A diagram language: what a language plugs into the generic seam. */
export interface DiagramLanguage {
  /**
   * The fence info string, lower-case (`mermaid`). Matched case-insensitively.
   * Also names the language's CSS classes (`cm-<id>`, `web-<id>-render`, …)
   * and the web error panel's `data-testid` (`<id>-error`), so it must be a
   * single token with no spaces.
   */
  readonly id: string;
  /**
   * Lazily load the language's engine and return its renderer. Called at most
   * once per session (memoised by `rendererFor`), and only when a fence in this
   * language is actually rendered, so a document without one never pays for
   * the engine's bundle.
   */
  readonly load: () => Promise<DiagramRenderer>;
  /**
   * Post-process a rendered SVG before it is cached and inserted into the
   * document. This is where an SVG sanitiser plugs in (dr-2) for a language
   * whose output is not safe by construction. Required, so every language has
   * to decide; pass `identity` only when the engine already guarantees a safe
   * SVG (mermaid, via `securityLevel: 'strict'`).
   */
  readonly sanitise: (svg: string) => string;
  /**
   * Optional global CSS the language needs, injected once into the document
   * the first time a diagram in this language renders. Scope every rule by the
   * language's own classes (`.cm-<id>`, `.web-<id>`) — e.g. a theme applied by
   * CSS custom properties instead of a re-render.
   */
  readonly stylesheet?: string;
}

/** The no-op `sanitise` for a language whose engine emits safe SVG itself. */
export const identity = (svg: string): string => svg;

/**
 * Find the registered language for a fence info string (trimmed, matched
 * case-insensitively), or `undefined` when the fence is not a diagram.
 */
export function findDiagramLanguage(
  languages: readonly DiagramLanguage[],
  info: string,
): DiagramLanguage | undefined {
  const wanted = info.trim().toLowerCase();
  if (wanted === '') return undefined;
  return languages.find((language) => language.id === wanted);
}

/**
 * The render cache key (ADR-0005 render caching, ADR-0014): a rendered SVG
 * depends on the language, the source and the resolved theme. Language and
 * theme are single tokens with no spaces, so the space-delimited prefix can
 * never collide with source text, and the same source in two languages never
 * shares an entry.
 */
export function diagramCacheKey(language: string, source: string, theme: ResolvedTheme): string {
  return `${language} ${theme} ${source}`;
}

const rendererPromises = new Map<string, Promise<DiagramRenderer>>();

/**
 * The language's renderer, loading its engine on first use. Concurrent and
 * later calls share the one `load()` promise, so the engine is imported once.
 */
export function rendererFor(language: DiagramLanguage): Promise<DiagramRenderer> {
  let promise = rendererPromises.get(language.id);
  if (!promise) {
    promise = language.load();
    rendererPromises.set(language.id, promise);
  }
  return promise;
}

/** Which DOM surface a diagram is drawn on: the editor or the web/print island. */
export type DiagramSurface = 'cm' | 'web';

/**
 * The class list for a diagram element: a generic class every language shares
 * (styled once — `cm-diagram-error`) plus the language's own (`cm-mermaid-error`),
 * which specs and language stylesheets select on. `part` is '' for the
 * container, else a suffix like `render`, `loading`, `error-message`.
 */
export function diagramClasses(surface: DiagramSurface, language: string, part = ''): string {
  const suffix = part === '' ? '' : `-${part}`;
  return `${surface}-diagram${suffix} ${surface}-${language}${suffix}`;
}
