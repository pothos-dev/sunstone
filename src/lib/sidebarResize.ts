// Pure geometry for the resizable sidebars (slices:
// edge-sidebars-delete-navbar, rail-sidebar-toggles). The `.svelte` edge
// component wires pointer / keyboard events to these helpers; keeping the
// arithmetic here (no DOM, no runes) makes the clamp rules unit-testable in
// isolation.
//
// A sidebar is measured by its content WIDTH in CSS pixels (unlike the tiling
// dividers, which use fractional weights — see `tileLayout.ts`). A sidebar's
// border is a pure drag-to-resize handle; collapse/expand lives on the always-
// visible ActivityRail's toggle button, not on the border.

/** Smallest width a sidebar may be dragged to (still comfortably usable). */
export const MIN_SIDEBAR_WIDTH = 180;
/** Largest width a sidebar may be dragged to (keeps the editor usable). */
export const MAX_SIDEBAR_WIDTH = 560;
/** Fresh/older-Bundle default width (matches the old hard-coded CSS). */
export const DEFAULT_SIDEBAR_WIDTH = 280;
/** Keyboard-resize step (Arrow keys on a focused edge). */
export const KEYBOARD_RESIZE_STEP = 24;

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
