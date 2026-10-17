// D2 compile + render, engine-agnostic — PURE, no DOM (dr-3, ADR-0014).
//
// Runs inside the D2 Web Worker (`d2Worker.ts`) against `@terrastruct/d2`'s
// `D2` class, and under `bun test` against a stub. Owns the render options we
// force on every diagram, the error-message cleanup, and the queue that keeps
// calls into one `D2` instance strictly one at a time.

/** The slice of `@terrastruct/d2`'s `D2` class we use. */
export interface D2Like {
  compile(source: string): Promise<{ diagram: unknown; renderOptions: D2RenderOptions }>;
  render(diagram: unknown, options: D2RenderOptions): Promise<string>;
}

/** The render options we read or force (a subset of D2's `RenderOptions`). */
export interface D2RenderOptions {
  sketch?: boolean | null;
  themeID?: number | null;
  darkThemeID?: number | null;
  themeOverrides?: unknown;
  darkThemeOverrides?: unknown;
  pad?: number | null;
  scale?: number | null;
  center?: boolean | null;
  salt?: string | null;
  noXMLTag?: boolean | null;
  forceAppendix?: boolean | null;
  animateInterval?: number | null;
  [key: string]: unknown;
}

/** Padding around a rendered diagram, in px. D2's default (100) is a poster margin. */
export const D2_PAD = 16;

/**
 * The options a diagram renders with: the source's own (`sketch`, `center`, a
 * `target` board, …, as `compile` merged them from its `vars`) with the
 * palette and the embedding forced.
 *
 *  - `themeID: 0`, no dark theme, no theme overrides: one fixed set of slot
 *    classes, which `d2Theme.ts` recolours. A `theme-id` in the source has no
 *    effect, and no `prefers-color-scheme` block competes with the app theme.
 *  - `salt`: a per-render string, so two diagrams on one page never share ids
 *    (markers, masks, the scoping class).
 *  - `scale: 1`: the SVG keeps its natural width/height instead of stretching
 *    to its container; the surface caps it at 100% width.
 *  - no appendix and no animation: links, tooltips and animated boards are
 *    out of scope (the effort README) and render as static shapes.
 */
export function d2RenderOptions(fromSource: D2RenderOptions, salt: string): D2RenderOptions {
  return {
    ...fromSource,
    themeID: 0,
    darkThemeID: null,
    themeOverrides: null,
    darkThemeOverrides: null,
    salt,
    noXMLTag: true,
    pad: D2_PAD,
    scale: 1,
    forceAppendix: false,
    animateInterval: 0,
  };
}

/**
 * D2 rejects a bad source with its diagnostics serialised as JSON
 * (`[{"range":"…","errmsg":"index:1:6: maps must be terminated with }"}]`).
 * Turn that into one diagnostic per line for the error panel; any other
 * message passes through unchanged.
 */
export function formatD2Error(message: string): string {
  const trimmed = message.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return message;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const lines = list
      .map((entry) =>
        entry && typeof entry === 'object' && 'errmsg' in entry ? String(entry.errmsg) : '',
      )
      .filter((line) => line !== '');
    return lines.length > 0 ? lines.join('\n') : message;
  } catch {
    return message;
  }
}

/** Compile and render one diagram on `d2`; rejects with a readable message. */
export async function compileAndRender(d2: D2Like, source: string, salt: string): Promise<string> {
  try {
    const { diagram, renderOptions } = await d2.compile(source);
    return await d2.render(diagram, d2RenderOptions(renderOptions, salt));
  } catch (err) {
    throw new Error(formatD2Error(err instanceof Error ? err.message : String(err)));
  }
}

/**
 * A one-at-a-time queue. `@terrastruct/d2` keeps a single pending
 * resolve/reject per instance, so two overlapping calls would cross their
 * results; every call goes through here instead. A failed task does not stall
 * the ones behind it.
 */
export function serialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}
