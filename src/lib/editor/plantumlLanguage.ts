// PlantUML, the third language on the diagram seam (dr-4, ADR-0016).
//
// The engine is `@plantuml/core`, PlantUML's official build compiled from Java
// to JavaScript with TeaVM, with Graphviz from viz.js's WASM build. It loads
// with a dynamic `import()` the first time a ` ```plantuml ` fence renders, so
// neither shell pays for its ~8.6 MB until a document needs it.
//
// It runs on the main thread, unlike D2: it builds its SVG with
// `document.createElementNS` and measures text on a canvas and with `getBBox`,
// so it needs a real DOM. Parsing the engine takes ~0.4 s once per session,
// and a small diagram renders in 15–300 ms after that.
//
// Its output is author-controlled SVG (links, `<img:…>` images), so it goes
// through dr-2's sanitiser. It is themed at render time by a `<style>` preamble
// (`plantumlTheme.ts`), so the theme is part of its cache key, as for mermaid.

import type { DiagramLanguage, DiagramRenderer } from './diagramLanguage';
import { renderPlantUml, usesEmoji, type PlantUmlLike } from './plantumlEngine';
import { plantumlStylePreamble } from './plantumlTheme';
import { serialQueue } from './serialQueue';
import { sanitiseSvg } from '../svg/sanitiseSvg';

/** A script-load record in the engine's `window.__pl_script_state` table. */
interface ScriptState {
  state: 'loaded';
  ok: (() => void)[];
  err: ((message: string) => void)[];
}

/**
 * Stop the engine from loading scripts. For `<&icon>`, `<:emoji:>` and
 * `!include <stdlib/…>` it appends a `<script src>` with a path relative to
 * the page (`openiconic.js`, `emoji.js`, `c4.min.js`), which would run
 * whatever our origin serves there. It consults `window.__pl_script_state`
 * first and skips any script recorded as loaded, so a table that reports
 * every script as loaded turns the loader off. The icon and emoji tables
 * are imported from the package instead; the standard library is not
 * shipped, and `!include <…>` fails with PlantUML's "cannot include".
 */
function disableScriptLoads(): void {
  const loaded = (): ScriptState => ({ state: 'loaded', ok: [], err: [] });
  // A plain property: the engine re-assigns it (`w.x = w.x || {}`), which
  // would throw in its strict-mode module if the property were read-only.
  (window as unknown as { __pl_script_state: unknown }).__pl_script_state = new Proxy(
    Object.create(null) as Record<string, ScriptState>,
    { get: loaded },
  );
}

let emoji: Promise<unknown> | undefined;

/** The emoji table (1.9 MB), imported on the first source that uses one. */
function loadEmoji(): Promise<unknown> {
  emoji ??= import('@plantuml/core/emoji.js');
  return emoji;
}

/**
 * The Graphviz layout engine. `viz-global.js` is a UMD bundle that the engine
 * reads as `window.Viz`. Imported as a module it may define the global itself
 * or only export it, depending on how the bundler wraps it; cover both.
 */
async function loadViz(): Promise<void> {
  const viz = (await import('@plantuml/core/viz-global.js')) as { instance?: unknown; default?: unknown };
  const scope = window as unknown as { Viz?: unknown };
  scope.Viz ??= typeof viz.instance === 'function' ? viz : viz.default;
}

/** Load the engine and return the renderer. Renders run one at a time. */
async function loadPlantUml(): Promise<DiagramRenderer> {
  disableScriptLoads();
  await Promise.all([loadViz(), import('@plantuml/core/openiconic.js')]);
  const engine: PlantUmlLike = await import('@plantuml/core');
  const enqueue = serialQueue();
  return ({ source, read }) =>
    enqueue(async () => {
      if (usesEmoji(source)) await loadEmoji();
      return renderPlantUml(engine, source, plantumlStylePreamble(read));
    });
}

export const plantumlLanguage: DiagramLanguage = {
  id: 'plantuml',
  load: loadPlantUml,
  // PlantUML has no safe mode we can rely on: `[[links]]` become `<a href>`,
  // `<img:…>` an `<image>`. dr-2's sanitiser strips them.
  sanitise: (svg) => sanitiseSvg(svg),
  // PlantUML lays text out with widths it measured at the normal weight and
  // spacing, but SVG text inherits the page's (the editor body is weight
  // 500), which pushed labels past their boxes. Reset them on the root: the
  // engine's own `font-weight="bold"` on a `<text>` still wins over inheritance.
  stylesheet: `
:is(.cm-plantuml, .web-plantuml) svg {
  font-weight: normal;
  font-style: normal;
  letter-spacing: normal;
  word-spacing: normal;
  font-stretch: normal;
  font-variation-settings: normal;
  font-feature-settings: normal;
}`,
};
