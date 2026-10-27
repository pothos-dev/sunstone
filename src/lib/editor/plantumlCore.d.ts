// Types for `@plantuml/core`, which ships none (dr-4). Only what
// `plantumlLanguage.ts` uses.

declare module '@plantuml/core' {
  /** Render `lines` (one PlantUML source line each) to an SVG string. */
  export function renderToString(
    lines: string[],
    onSuccess: (svg: string) => void,
    onError: (message: string) => void,
    options?: { dark?: boolean },
  ): void;
}

/** Graphviz (viz.js), a UMD bundle the engine reads as `window.Viz`. */
declare module '@plantuml/core/viz-global.js';
/** Sets `window.PLANTUML_OPENICONIC`, the `<&icon>` table. */
declare module '@plantuml/core/openiconic.js';
/** Sets `window.PLANTUML_EMOJI`, the `<:emoji:>` table. */
declare module '@plantuml/core/emoji.js';
