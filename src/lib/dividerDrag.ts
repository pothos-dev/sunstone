// Shared pointer-capture drag loop for App.svelte's column/tile dividers. The
// two handlers there differed only in axis (x for columns, y for tile stacks)
// and in which pure `tileLayout` resize function consumed the fraction — this
// hoists the identical plumbing (pointer capture, window move/up listeners,
// delta-as-fraction math) into one helper.

export type DragAxis = 'x' | 'y';

/**
 * The pure per-move math: total pointer travel from the drag start as a
 * fraction of the container's axis size. The size is clamped to >= 1 so a
 * zero-measured container can't divide by zero.
 */
export function dragFraction(start: number, current: number, size: number): number {
  return (current - start) / Math.max(size, 1);
}

export interface DividerDragOptions {
  /** The divider's pointerdown event. */
  event: PointerEvent;
  /** Drag axis: 'x' reads clientX (column dividers), 'y' clientY (tile dividers). */
  axis: DragAxis;
  /** The container's size along the axis, measured at pointer-down (unclamped). */
  size: number;
  /**
   * Called on every pointermove with the total fraction dragged since
   * pointer-down. The caller applies it to the layout SNAPSHOT it captured at
   * pointer-down, so the clamp stays idempotent (dragging past a neighbour's
   * minimum stops cleanly and reversing recovers).
   */
  onFraction: (fraction: number) => void;
}

/**
 * Start a divider drag from a pointerdown. Calls `event.preventDefault()`,
 * best-effort pointer-captures the divider, and tracks the pointer via window
 * listeners until pointerup. The caller is responsible for any pre-checks
 * (primary button, container present) BEFORE calling.
 */
export function startDividerDrag({ event, axis, size, onFraction }: DividerDragOptions): void {
  event.preventDefault();
  const start = axis === 'x' ? event.clientX : event.clientY;
  const el = event.currentTarget as HTMLElement;
  try {
    el.setPointerCapture(event.pointerId);
  } catch {
    /* best-effort: window listeners below catch the moves regardless */
  }
  const move = (ev: PointerEvent) => {
    const current = axis === 'x' ? ev.clientX : ev.clientY;
    onFraction(dragFraction(start, current, size));
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
