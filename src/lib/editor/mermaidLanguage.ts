// Mermaid, the first language on the diagram seam (dr-1, ADR-0005/0014).
//
// The only module that imports `mermaid` or configures it. Everything else
// (detection, widget, cache, placeholder, error panel, theme rebuild, web and
// print hydration) is the generic seam in `diagramLanguage.ts` & co.

import { identity, type DiagramLanguage, type DiagramRenderer } from './diagramLanguage';
import { mermaidThemeConfig } from './mermaidTheme';

/**
 * The init options every render uses. OKF bundles are shareable, so a
 * diagram's source may be untrusted — strict sanitisation (no click callbacks,
 * no raw HTML labels) is the safe default (ADR-0005). `suppressErrorRendering`
 * stops mermaid injecting its OWN error graph into the DOM on a parse failure;
 * the seam renders its own error panel.
 */
const BASE_CONFIG = {
  // No auto-scan; we render each diagram explicitly via `render`.
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
} as const;

/** Load mermaid (dynamic import, own chunk), initialise it, return the renderer. */
async function loadMermaid(): Promise<DiagramRenderer> {
  const mermaid = (await import('mermaid')).default;
  mermaid.initialize(BASE_CONFIG);

  return async ({ source, theme, read, renderId }) => {
    // Theme the diagram with the app's own palette + font (mermaid's `base`
    // theme with our `themeVariables`). Mermaid bakes colours into the SVG at
    // render time, so re-`initialize` per render keeps it in step with the
    // app's light/dark scheme (ADR-0005, theme-sync).
    mermaid.initialize({ ...BASE_CONFIG, ...mermaidThemeConfig(read, theme) });
    try {
      const { svg } = await mermaid.render(renderId, source);
      return svg;
    } catch (err) {
      // Belt-and-suspenders: remove any temporary render element mermaid may
      // have left appended to the document on failure, so no orphan diagram
      // lingers in the page.
      document.getElementById(renderId)?.remove();
      document.getElementById(`d${renderId}`)?.remove();
      throw err;
    }
  };
}

export const mermaidLanguage: DiagramLanguage = {
  id: 'mermaid',
  load: loadMermaid,
  // `securityLevel: 'strict'` is mermaid's own guarantee.
  sanitise: identity,
  // Mermaid sets fonts inline from `fontFamily`; force the app UI font across
  // all editor diagram text (incl. htmlLabel spans) so a Diagram never falls
  // back to mermaid's default sans (ADR-0005, theme-sync).
  stylesheet: `
.cm-mermaid svg, .cm-mermaid svg text, .cm-mermaid svg .nodeLabel,
.cm-mermaid svg .edgeLabel, .cm-mermaid svg span {
  font-family: var(--font-ui) !important;
}`,
};
