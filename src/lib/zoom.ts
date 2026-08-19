// Pure UI-zoom maths (see `state/zoom.svelte.ts` for the store that applies it).
//
// Zoom is a single multiplier over the pinned root font-size (`app.css` pins
// `html { font-size: 16px }`) plus the two hard-coded content sizes that do NOT
// derive from `rem` (the CodeMirror body size and the rendered-article size).
// Keeping the stepping/clamping here means it can be unit-tested without a DOM.

/** Discrete zoom stops, browser-style. `1` (100%) is always one of them. */
export const ZOOM_STEPS = [
  0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5,
] as const;

export const DEFAULT_ZOOM = 1;
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** Clamp an arbitrary (e.g. persisted, possibly corrupt) value into range. */
export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale)) return DEFAULT_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/** The next stop above `scale` (or `scale` itself when already at the top). */
export function zoomIn(scale: number): number {
  const cur = clampZoom(scale);
  return ZOOM_STEPS.find((s) => s > cur + 1e-9) ?? MAX_ZOOM;
}

/** The next stop below `scale` (or `scale` itself when already at the bottom). */
export function zoomOut(scale: number): number {
  const cur = clampZoom(scale);
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    if (ZOOM_STEPS[i] < cur - 1e-9) return ZOOM_STEPS[i];
  }
  return MIN_ZOOM;
}

/** Ctrl/Cmd+wheel: one step per notch. `0` when the gesture isn't a zoom. */
export function wheelZoomStep(e: {
  ctrlKey: boolean;
  metaKey: boolean;
  deltaY: number;
}): -1 | 0 | 1 {
  if (!e.ctrlKey && !e.metaKey) return 0;
  if (e.deltaY < 0) return 1;
  if (e.deltaY > 0) return -1;
  return 0;
}
