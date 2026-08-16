// Client-side Mermaid Diagram hydration for the web viewer
// (slice: web-mermaid-diagrams).
//
// The server leaves ` ```mermaid ` fences as inert code (comrak emits
// `<pre><code class="language-mermaid">source</code></pre>`); this island scans
// the rendered Concept HTML for those blocks and renders each into a Diagram in
// the browser — the read-only web analogue of the desktop's live-preview
// Diagram. It is a thin adapter over the SHARED render engine
// (`editor/mermaidRender.ts` — lazy `import('mermaid')`,
// `securityLevel: 'strict'`, the app's own palette/font baked in per theme, the
// `(source, theme) → SVG` cache, and a graceful bordered error panel on a
// malformed diagram, never breaking the page), parameterised with the
// `web-mermaid-*` class prefix.

import type { ResolvedTheme } from '../editor/mermaidTheme';
import { renderDiagram } from '../editor/mermaidRender';

/** CSS class marking a hydrated diagram container (the source rides on it). */
const CONTAINER_CLASS = 'web-mermaid';

/**
 * Hydrate/render every mermaid Diagram inside `root` in the given `theme`.
 *
 * Two idempotent passes:
 *   1. Convert each fresh `<pre><code class="language-mermaid">` into a
 *      `.web-mermaid` container carrying the source on a data attribute (so a
 *      later theme re-render can re-render it without the original code block).
 *   2. Render (or re-render) every `.web-mermaid` container in `theme`.
 *
 * Safe to call repeatedly: on Concept navigation the `{@html}` swap produces
 * fresh code blocks (pass 1 handles them); on a theme flip the containers
 * already exist (pass 2 re-renders them in the new palette). A malformed diagram
 * shows a bordered error panel in place — it never throws out of here.
 */
export async function hydrateMermaid(root: HTMLElement, theme: ResolvedTheme): Promise<void> {
  // Pass 1: convert fresh code blocks into stable containers.
  for (const code of Array.from(root.querySelectorAll('code.language-mermaid'))) {
    const pre = code.closest('pre') ?? code;
    const container = document.createElement('div');
    container.className = CONTAINER_CLASS;
    container.dataset.mermaidSource = code.textContent ?? '';
    const render = document.createElement('div');
    render.className = 'web-mermaid-render';
    container.appendChild(render);
    pre.replaceWith(container);
  }

  // Resolve the app palette/font from the themed root NOW (mermaid bakes colours
  // into the SVG at render time). `read` is the injected CSS-var reader.
  const cs = getComputedStyle(root);
  const read = (name: string) => cs.getPropertyValue(name).trim();

  // Pass 2: render every container in the current theme.
  const containers = Array.from(root.querySelectorAll<HTMLElement>(`.${CONTAINER_CLASS}`));
  await Promise.all(
    containers.map((container) => {
      const source = container.dataset.mermaidSource ?? '';
      const target = container.querySelector<HTMLElement>('.web-mermaid-render') ?? container;
      // Render via the shared engine; the error panel carries the
      // `data-testid` the web e2e suite asserts on.
      return renderDiagram(target, source, theme, {
        classPrefix: CONTAINER_CLASS,
        read,
        errorTestId: 'mermaid-error',
      });
    }),
  );
}
