// Pure geometry for the edge-toggle + resizable sidebars (slice:
// edge-sidebars-delete-navbar). The `.svelte` edge component wires pointer /
// keyboard events to these helpers; keeping the arithmetic here (no DOM, no
// runes) makes the clamp + click-vs-drag rules unit-testable in isolation.
//
// A sidebar is measured by its content WIDTH in CSS pixels (unlike the tiling
// dividers, which use fractional weights — see `tileLayout.ts`). Each sidebar's
// border doubles as a collapse/expand click target and a drag-to-resize handle;
// which of the two a gesture is depends purely on how far the pointer travelled.

/** Smallest width a sidebar may be dragged to (still comfortably usable). */
export const MIN_SIDEBAR_WIDTH = 180;
/** Largest width a sidebar may be dragged to (keeps the editor usable). */
export const MAX_SIDEBAR_WIDTH = 560;
/** Fresh/older-Bundle default width (matches the old hard-coded CSS). */
export const DEFAULT_SIDEBAR_WIDTH = 280;
/**
 * Width a COLLAPSED sidebar keeps: a thin sliver of its backdrop still peeks at
 * the window edge (rather than vanishing to 0), so the border/grab-edge stays
 * discoverable. The fixed-width inner slides out under the clip, so the peek
 * shows only backdrop, not content.
 */
export const COLLAPSED_SIDEBAR_WIDTH = 10;
/** Keyboard-resize step (Arrow keys on a focused edge). */
export const KEYBOARD_RESIZE_STEP = 24;
/**
 * Pointer travel (px, either axis) past which a border gesture counts as a
 * RESIZE rather than a click: under it a pointerup toggles collapse/expand; at
 * or over it the gesture resized and the toggle is suppressed.
 */
export const DRAG_THRESHOLD_PX = 4;

/** Which side of the editor a sidebar sits on (drives the drag direction). */
export type SidebarSide = 'left' | 'right';

/**
 * Clamp a width to `[min, max]`. A non-finite input (e.g. a corrupt persisted
 * value) falls back to the default so a bad store can never wedge the layout.
 */
export function clampSidebarWidth(
  width: number,
  min: number = MIN_SIDEBAR_WIDTH,
  max: number = MAX_SIDEBAR_WIDTH,
): number {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.max(min, Math.min(max, width));
}

/**
 * The new width after dragging a sidebar's border by `deltaX` px from `base`.
 * The LEFT sidebar's border is on its right edge, so dragging right (+deltaX)
 * grows it; the RIGHT sidebar's border is on its left edge, so dragging left
 * (−deltaX) grows it. The result is clamped to `[min, max]`, so a drag past a
 * bound stops cleanly and reversing recovers (idempotent from a captured base).
 */
export function resizeSidebarWidth(
  base: number,
  deltaX: number,
  side: SidebarSide,
  min: number = MIN_SIDEBAR_WIDTH,
  max: number = MAX_SIDEBAR_WIDTH,
): number {
  const raw = side === 'left' ? base + deltaX : base - deltaX;
  return clampSidebarWidth(raw, min, max);
}

/**
 * Whether a border gesture moved far enough (on either axis) to be a resize
 * drag rather than a click. Used at pointerup: below the threshold the border
 * click toggles collapse/expand; at or above it the drag already resized.
 */
export function isDragGesture(
  deltaX: number,
  deltaY: number,
  threshold: number = DRAG_THRESHOLD_PX,
): boolean {
  return Math.abs(deltaX) >= threshold || Math.abs(deltaY) >= threshold;
}
