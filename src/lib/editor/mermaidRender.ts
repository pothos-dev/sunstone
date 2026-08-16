// Shared mermaid render engine (CodeMirror-free), used by BOTH the desktop
// editor's block widget (`editor/mermaid.ts`) and the web viewer's hydration
// island (`web/webMermaid.ts`). Covers the lazy module load, the render-id
// sequence, the `(source, theme) → SVG` cache, the per-host generation token,
// the loading placeholder, the bordered error panel, and mermaid's per-render
// theming. Call sites differ only in their CSS class prefix, their CSS-var
// reader, and (for the web island) a `data-testid` on the error panel — all
// injected via `MermaidRenderOptions`.

import {
  mermaidThemeConfig,
  mermaidCacheKey,
  type CssVarReader,
  type ResolvedTheme,
} from './mermaidTheme';

/**
 * Lazily-resolved mermaid module + one-time `initialize`. The dynamic import is
 * only triggered when a document actually contains a mermaid block, so
 * diagram-free Concepts never pull mermaid's large bundle. Cached as a promise
 * so concurrent renders share one import.
 */
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

export function ensureMermaid(): Promise<typeof import('mermaid').default> {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = import('mermaid').then((mod) => {
    const mermaid = mod.default;
    mermaid.initialize({
      // No auto-scan; we render each diagram explicitly via `render`.
      startOnLoad: false,
      // OKF bundles are shareable, so a diagram's source may be untrusted —
      // strict sanitisation (no click callbacks, no raw HTML labels) is the
      // safe default (ADR-0005). Interactivity is a later concern.
      securityLevel: 'strict',
      // Stop mermaid from injecting its OWN error graph into the DOM on a
      // parse failure — we render our own in-place error panel.
      suppressErrorRendering: true,
    });
    return mermaid;
  });
  return mermaidPromise;
}

/** Monotonic id source for unique mermaid render ids (mermaid requires one). */
let renderSeq = 0;

/**
 * Module-level `(source, theme) → SVG` cache (render-caching slice, ADR-0005
 * option 9a), SHARED between the desktop widget and the web island. An
 * identical diagram (same source + theme) paints instantly from memory rather
 * than re-running mermaid. Keyed by `mermaidCacheKey`.
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

/** Per-call-site knobs for `renderDiagram` / `buildErrorPanel`. */
export interface MermaidRenderOptions {
  /** CSS class prefix for every element this engine creates (e.g. `cm-mermaid`). */
  classPrefix: string;
  /** CSS-var reader resolving the app palette/font from the themed root. */
  read: CssVarReader;
  /** Optional `data-testid` set on the error panel. */
  errorTestId?: string;
}

/**
 * Build the error-state panel for a failed `mermaid.render()` (error-state
 * slice, ADR-0005 option 4a). A bordered panel surfaces mermaid's error
 * message, with the raw fence source rendered beneath it, so the user sees both
 * what is broken and what they typed. The `<prefix>-error` class makes a broken
 * diagram visibly distinct from a plain code block. DOM-only and pure; message
 * + source set as textContent (never innerHTML) so a malicious diagram source
 * can't smuggle markup through the error path.
 */
export function buildErrorPanel(
  message: string,
  source: string,
  classPrefix: string,
  errorTestId?: string,
): HTMLElement {
  const panel = document.createElement('div');
  panel.className = `${classPrefix}-error`;
  if (errorTestId !== undefined) panel.setAttribute('data-testid', errorTestId);

  const heading = document.createElement('div');
  heading.className = `${classPrefix}-error-heading`;
  heading.textContent = 'Diagram error';
  panel.appendChild(heading);

  const msg = document.createElement('div');
  msg.className = `${classPrefix}-error-message`;
  msg.textContent = message;
  panel.appendChild(msg);

  const raw = document.createElement('pre');
  raw.className = `${classPrefix}-error-source`;
  raw.textContent = source;
  panel.appendChild(raw);

  return panel;
}

/**
 * Render `source` into `host` as an SVG diagram in the given resolved app
 * `theme`. Cache hit paints instantly; otherwise shows a muted placeholder,
 * lazy-loads mermaid, applies the app-palette theme via `initialize` (mermaid
 * bakes colours into the SVG at render time, so re-`initialize` per render
 * keeps the diagram in step with the app's light/dark scheme — ADR-0005,
 * theme-sync), renders, and swaps in the SVG. A failure shows a bordered error
 * panel (mermaid's message + the raw source) in place — it never throws out of
 * here. Errors are NOT cached: fixing the source must re-attempt the render.
 * Discards its result if a newer render for the host superseded it.
 */
export async function renderDiagram(
  host: HTMLElement,
  source: string,
  theme: ResolvedTheme,
  options: MermaidRenderOptions,
): Promise<void> {
  const { classPrefix, read, errorTestId } = options;

  // Claim a fresh generation for this render; any earlier in-flight render for
  // this host is now stale and must not paint.
  const generation = (hostGeneration.get(host) ?? 0) + 1;
  hostGeneration.set(host, generation);
  const current = () => hostGeneration.get(host) === generation;

  const key = mermaidCacheKey(source, theme);

  // Cache hit: an identical diagram (same source + theme) was rendered before —
  // paint synchronously from memory, no fresh `mermaid.render()`.
  const cached = svgCache.get(key);
  if (cached !== undefined) {
    host.innerHTML = cached;
    return;
  }

  // Resolve the app palette/font NOW (synchronously, before the async render) —
  // concrete values are required, mermaid bakes colours into the SVG.
  const themeConfig = mermaidThemeConfig(read, theme);

  const placeholder = document.createElement('div');
  placeholder.className = `${classPrefix}-loading`;
  placeholder.textContent = 'Rendering diagram…';
  host.innerHTML = '';
  host.appendChild(placeholder);

  const id = `${classPrefix}-${renderSeq++}`;
  try {
    const mermaid = await ensureMermaid();
    // Theme the diagram with the app's own palette + font (mermaid's `base`
    // theme with our `themeVariables`), not mermaid's generic dark/default.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      ...themeConfig,
    });
    const { svg } = await mermaid.render(id, source);
    // Cache the successful render for instant repaint of identical diagrams.
    svgCache.set(key, svg);
    // Discard a stale render: only paint if THIS render is still the newest
    // for the host (generation unchanged) and the host is still mounted.
    if (!host.isConnected || !current()) return;
    host.innerHTML = svg;
  } catch (err: unknown) {
    // Belt-and-suspenders: remove any temporary render element mermaid may have
    // left appended to the document on failure (in addition to
    // `suppressErrorRendering`), so no orphan diagram lingers in the page.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
    if (!host.isConnected || !current()) return;
    const message = err instanceof Error ? err.message : String(err);
    host.innerHTML = '';
    host.appendChild(buildErrorPanel(message, source, classPrefix, errorTestId));
  }
}
