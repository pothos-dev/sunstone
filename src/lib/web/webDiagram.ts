// Client-side Diagram hydration for the web viewer and the print path
// (slice: web-mermaid-diagrams; dr-1, ADR-0014).
//
// The server leaves diagram fences as inert code (comrak emits
// `<pre><code class="language-mermaid">source</code></pre>`); this island scans
// the rendered Concept HTML for those blocks, for every language registered in
// `editor/diagramLanguages.ts`, and renders each into a Diagram in the browser —
// the read-only web analogue of the desktop's live-preview Diagram. It is a thin
// adapter over the SHARED render engine (`editor/diagramRender.ts` — lazy engine
// load, the `(language, source, theme) → SVG` cache, and a graceful bordered
// error panel on a malformed diagram, never breaking the page), on the `web`
// surface (`web-diagram-*` + `web-<language>-*` classes).

import { diagramClasses, findDiagramLanguage, type ResolvedTheme } from '../editor/diagramLanguage';
import { DIAGRAM_LANGUAGES } from '../editor/diagramLanguages';
import { renderDiagram } from '../editor/diagramRender';

/** CSS class marking a hydrated diagram container (language + source ride on it). */
const CONTAINER_CLASS = 'web-diagram';
const RENDER_CLASS = 'web-diagram-render';

/**
 * Hydrate/render every Diagram inside `root` in the given `theme`.
 *
 * Two idempotent passes:
 *   1. Convert each fresh `<pre><code class="language-<id>">` of a registered
 *      language into a `.web-diagram` container carrying the language and the
 *      source on data attributes (so a later theme re-render can re-render it
 *      without the original code block).
 *   2. Render (or re-render) every `.web-diagram` container in `theme`.
 *
 * Safe to call repeatedly: on Concept navigation the `{@html}` swap produces
 * fresh code blocks (pass 1 handles them); on a theme flip the containers
 * already exist (pass 2 re-renders them in the new palette). A malformed diagram
 * shows a bordered error panel in place — it never throws out of here. A
 * language's engine is only loaded when `root` holds a fence in it.
 */
export async function hydrateDiagrams(root: HTMLElement, theme: ResolvedTheme): Promise<void> {
  // Pass 1: convert fresh code blocks into stable containers.
  for (const language of DIAGRAM_LANGUAGES) {
    for (const code of Array.from(root.querySelectorAll(`code.language-${language.id}`))) {
      const pre = code.closest('pre') ?? code;
      const container = document.createElement('div');
      container.className = diagramClasses('web', language.id);
      container.dataset.diagramLanguage = language.id;
      container.dataset.diagramSource = code.textContent ?? '';
      const render = document.createElement('div');
      render.className = diagramClasses('web', language.id, 'render');
      container.appendChild(render);
      pre.replaceWith(container);
    }
  }

  // Resolve the app palette/font from the themed root (a language may bake
  // colours into the SVG at render time). `read` is the injected CSS-var reader.
  const cs = getComputedStyle(root);
  const read = (name: string) => cs.getPropertyValue(name).trim();

  // Pass 2: render every container in the current theme.
  const containers = Array.from(root.querySelectorAll<HTMLElement>(`.${CONTAINER_CLASS}`));
  await Promise.all(
    containers.map((container) => {
      const language = findDiagramLanguage(
        DIAGRAM_LANGUAGES,
        container.dataset.diagramLanguage ?? '',
      );
      if (!language) return;
      const source = container.dataset.diagramSource ?? '';
      const target = container.querySelector<HTMLElement>(`.${RENDER_CLASS}`) ?? container;
      // The error panel carries the `<language>-error` `data-testid` the web
      // e2e suite asserts on (`mermaid-error`).
      return renderDiagram(target, language, source, theme, {
        surface: 'web',
        read,
        errorTestId: `${language.id}-error`,
      });
    }),
  );
}
