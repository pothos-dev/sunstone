// D2 Diagram theming — PURE, DOM- and CodeMirror-free (dr-3, ADR-0014).
//
// D2 colours every themed element by CLASS: a shape carries `fill-B6` and
// `stroke-B1`, a label `fill-N1`, and the SVG defines those classes in its own
// `<style>`, scoped by a per-diagram class (`.d2-2922646921 .fill-B6{…}`).
// Colours an author writes on a shape (`style.fill: "#f00"`) are literal
// attribute values with no class. So one global stylesheet that maps each slot
// class to an app CSS custom property recolours every themed element, leaves
// authored colours alone, and follows a light/dark flip with no re-render: the
// `var(--…)`s re-resolve against whatever theme the diagram sits in (the app
// root, or the print view's forced light paper).
//
// Our rules have to beat D2's two-class selector. Every rule here is prefixed
// with `D2_SCOPE` (specificity 0,2,1) and ends in the slot class, so the
// lightest rule is 0,3,1 against D2's 0,2,0. D2 uses no `!important`.
//
// The mapping mirrors `mermaidTheme.ts`, so both languages read as one family:
// surface fills, foreground borders and labels, muted edges, sunken containers
// with a strong-border outline. D2 has more shape kinds than mermaid, so its
// special slots (cylinders, steps, class/table headers) take accent tints.

/** D2's colour slots (d2themes: neutrals N1–N7, base B1–B6, accents AA*, AB*). */
export const D2_SLOTS = [
  'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7',
  'B1', 'B2', 'B3', 'B4', 'B5', 'B6',
  'AA2', 'AA4', 'AA5', 'AB4', 'AB5',
] as const;

export type D2Slot = (typeof D2_SLOTS)[number];

/** The CSS properties D2 sets through slot classes (`fill-N1`, `color-B2`, …). */
export const D2_SLOT_PROPERTIES = ['fill', 'stroke', 'background-color', 'color'] as const;

/**
 * Slot → app colour. What D2 uses each slot for, from its renderer:
 *   N1 labels · N2 connection labels · N3 faint text · N4 diamond/hexagon fill
 *   N5 queue fill · N6 subtle wells · N7 canvas, ovals, table/class bodies and
 *   text on B2 headers · B1 shape and connection strokes · B2 class/table
 *   headers · B3 person · B4 top-level containers · B5 shapes one level in
 *   · B6 top-level shapes · AA4/AA5 cylinders and stored data · AB4/AB5 steps
 *   and other special shapes · AA2 accents.
 */
export const D2_PALETTE: Readonly<Record<D2Slot, string>> = {
  N1: 'var(--text)',
  N2: 'var(--text-muted)',
  N3: 'var(--text-faint)',
  N4: 'var(--border-strong)',
  N5: 'var(--border)',
  N6: 'var(--bg-sunken)',
  N7: 'var(--bg-elevated)',
  B1: 'var(--text)',
  B2: 'var(--accent)',
  B3: 'var(--bg-elevated)',
  B4: 'var(--bg-sunken)',
  B5: 'var(--bg-elevated)',
  B6: 'var(--bg-elevated)',
  AA2: 'var(--accent)',
  AA4: 'color-mix(in srgb, var(--accent) 14%, var(--bg-elevated))',
  AA5: 'color-mix(in srgb, var(--accent) 7%, var(--bg-elevated))',
  AB4: 'color-mix(in srgb, var(--text) 8%, var(--bg-elevated))',
  AB5: 'color-mix(in srgb, var(--text) 4%, var(--bg-elevated))',
};

/**
 * Overrides for slots D2 shares between roles mermaid keeps apart. B1 strokes
 * both shapes and connections; connections (and their arrowheads, which D2
 * draws as `fill-B1` markers) take the muted foreground, as mermaid's edges do.
 * A top-level container is the only B4 fill, so its B1 border is softened to
 * mermaid's cluster border.
 */
export const D2_ROLE_RULES: readonly (readonly [selector: string, declaration: string])[] = [
  ['.connection.stroke-B1', 'stroke: var(--text-muted)'],
  ['.connection.fill-B1', 'fill: var(--text-muted)'],
  ['.fill-B4.stroke-B1', 'stroke: var(--border-strong)'],
  // The diagram's background rect: transparent, so the diagram sits on the
  // page (the editor's paper gradient, the printed sheet) instead of a slab.
  ['> rect.fill-N7:first-child', 'fill: transparent'],
];

/**
 * Every D2 rule is scoped under this. `:is(…)` counts as one class, so the
 * prefix is 0,2,1 and any rule below it out-ranks D2's `.d2-<hash> .fill-X`.
 * The classes are the diagram seam's language classes for D2 (`cm-d2`, the
 * editor; `web-d2`, the web viewer and print).
 */
export const D2_SCOPE = ':is(.cm-d2, .web-d2) svg.d2-svg';

/** The global stylesheet that themes every D2 Diagram with the app palette. */
export function d2Stylesheet(): string {
  const rules: string[] = [];
  for (const slot of D2_SLOTS) {
    for (const property of D2_SLOT_PROPERTIES) {
      rules.push(`${D2_SCOPE} .${property}-${slot} { ${property}: ${D2_PALETTE[slot]}; }`);
    }
  }
  for (const [selector, declaration] of D2_ROLE_RULES) {
    rules.push(`${D2_SCOPE} ${selector} { ${declaration}; }`);
  }
  return rules.join('\n');
}
