// The shared diagram render engine (dr-1, ADR-0005/0014), CodeMirror-free,
// used by BOTH the desktop editor's block widget (`editor/diagram.ts`) and the
// web viewer / print hydration island (`web/webDiagram.ts`), for every
// registered diagram language. Covers the lazy engine load (through
// `rendererFor`), the render-id sequence, the `(language, source, theme) → SVG`
// cache, the per-host generation token, the loading placeholder, the bordered
// error panel, the sanitise hook and the language stylesheet. Call sites differ
// only in their surface (`cm` / `web` class prefix), their CSS-var reader, and
// (for the web island) a `data-testid` on the error panel.

import {
  diagramClasses,
  languageCacheKey,
  rendererFor,
  type CssVarReader,
  type DiagramLanguage,
  type DiagramSurface,
  type ResolvedTheme,
} from './diagramLanguage';

/** Monotonic id source for unique render ids (mermaid needs a DOM id, D2 a salt). */
let renderSeq = 0;

/**
 * Module-level `(language, source, theme) → SVG` cache (render caching,
 * ADR-0005 option 9a), SHARED between the desktop widget and the web island. An
 * identical diagram paints instantly from memory rather than re-rendering.
 * Holds post-`sanitise` SVG. Keyed by `languageCacheKey`.
 */
const svgCache = new Map<string, string>();

/**
 * Per-host generation token: each `renderDiagram` call bumps the host's
 * generation; an async render only paints if its captured generation is still
 * the host's current one. So if a NEWER render is kicked off (e.g. a fast
 * source-change-then-revert, a theme flip, a re-nav), the older in-flight
 * render — resolving later — is discarded rather than swapped in over the newer
 * result (no stale SVG ever displayed). Keyed by the host element via a WeakMap
 * so it is GC'd with the DOM.
 */
const hostGeneration = new WeakMap<HTMLElement, number>();

/** Languages whose `stylesheet` is already in the document. */
const injectedStylesheets = new Set<string>();

function ensureStylesheet(language: DiagramLanguage): void {
  if (!language.stylesheet || injectedStylesheets.has(language.id)) return;
  injectedStylesheets.add(language.id);
  const style = document.createElement('style');
  style.dataset.diagramLanguage = language.id;
  style.textContent = language.stylesheet;
  document.head.appendChild(style);
}

/** Per-call-site knobs for `renderDiagram`. */
export interface DiagramRenderOptions {
  /** Which surface draws the diagram; names every class this engine creates. */
  surface: DiagramSurface;
  /** CSS-var reader resolving the app palette/font from the themed root. */
  read: CssVarReader;
  /** Optional `data-testid` set on the error panel. */
  errorTestId?: string;
}

/**
 * Build the error-state panel for a failed render (error-state slice,
 * ADR-0005 option 4a). A bordered panel surfaces the language's error message,
 * with the raw fence source rendered beneath it, so the user sees both what is
 * broken and what they typed. The `-error` classes make a broken diagram
 * visibly distinct from a plain code block. DOM-only and pure; message + source
 * set as textContent (never innerHTML) so a malicious diagram source can't
 * smuggle markup through the error path.
 */
export function buildErrorPanel(
  message: string,
  source: string,
  surface: DiagramSurface,
  language: string,
  errorTestId?: string,
): HTMLElement {
  const panel = document.createElement('div');
  panel.className = diagramClasses(surface, language, 'error');
  if (errorTestId !== undefined) panel.setAttribute('data-testid', errorTestId);

  const heading = document.createElement('div');
  heading.className = diagramClasses(surface, language, 'error-heading');
  heading.textContent = 'Diagram error';
  panel.appendChild(heading);

  const msg = document.createElement('div');
  msg.className = diagramClasses(surface, language, 'error-message');
  msg.textContent = message;
  panel.appendChild(msg);

  const raw = document.createElement('pre');
  raw.className = diagramClasses(surface, language, 'error-source');
  raw.textContent = source;
  panel.appendChild(raw);

  return panel;
}

/**
 * Render `source` (in `language`) into `host` as an SVG diagram in the given
 * resolved app `theme`. Cache hit paints instantly; otherwise shows a muted
 * placeholder, lazy-loads the language's engine, renders, passes the SVG
 * through the language's `sanitise`, and swaps it in. A failure shows a
 * bordered error panel (the language's message + the raw source) in place — it
 * never throws out of here. Errors are NOT cached: fixing the source must
 * re-attempt the render. Discards its result if a newer render for the host
 * superseded it.
 */
export async function renderDiagram(
  host: HTMLElement,
  language: DiagramLanguage,
  source: string,
  theme: ResolvedTheme,
  options: DiagramRenderOptions,
): Promise<void> {
  const { surface, read, errorTestId } = options;

  // Claim a fresh generation for this render; any earlier in-flight render for
  // this host is now stale and must not paint.
  const generation = (hostGeneration.get(host) ?? 0) + 1;
  hostGeneration.set(host, generation);
  const current = () => hostGeneration.get(host) === generation;

  ensureStylesheet(language);

  const key = languageCacheKey(language, source, theme);

  // Cache hit: an identical diagram was rendered before — paint synchronously
  // from memory, no fresh render.
  const cached = svgCache.get(key);
  if (cached !== undefined) {
    host.innerHTML = cached;
    return;
  }

  const placeholder = document.createElement('div');
  placeholder.className = diagramClasses(surface, language.id, 'loading');
  placeholder.textContent = 'Rendering diagram…';
  host.innerHTML = '';
  host.appendChild(placeholder);

  const renderId = `${surface}-${language.id}-${renderSeq++}`;
  try {
    const render = await rendererFor(language);
    const svg = language.sanitise(await render({ source, theme, read, renderId }));
    // Cache the successful render for instant repaint of identical diagrams.
    svgCache.set(key, svg);
    // Discard a stale render: only paint if THIS render is still the newest
    // for the host (generation unchanged) and the host is still mounted.
    if (!host.isConnected || !current()) return;
    host.innerHTML = svg;
  } catch (err: unknown) {
    if (!host.isConnected || !current()) return;
    const message = err instanceof Error ? err.message : String(err);
    host.innerHTML = '';
    host.appendChild(buildErrorPanel(message, source, surface, language.id, errorTestId));
  }
}
