<script lang="ts">
  // A sidebar's border, purely a drag-to-resize handle (slices:
  // edge-sidebars-delete-navbar, then rail-sidebar-toggles). It used to double
  // as a collapse/expand click target; collapsing now lives on the always-
  // visible ActivityRail's toggle button, so the border does ONE thing — resize
  // — and no longer highlights on hover.
  //
  // The parent renders this only while its Sidebar is expanded: a collapsed
  // Sidebar is 0px wide with nothing to resize, and the rail owns the way back.
  //
  // The pure geometry (clamp, drag direction) lives in `sidebarResize.ts`; this
  // component only wires pointer/keyboard events to it and stays a thin
  // renderer, per the repo's pure-logic-in-.ts convention.
  import {
    resizeSidebarWidth,
    KEYBOARD_RESIZE_STEP,
    type SidebarSide,
  } from '$lib/sidebarResize';
  import { startPointerDrag } from '$lib/dividerDrag';

  interface Props {
    /** Which sidebar this edge belongs to (drives the drag direction). */
    side: SidebarSide;
    /** The sidebar's current width in px (the base a drag resizes from). */
    width: number;
    /** Accessible noun for the sidebar, e.g. "sidebar" / "Outline & Backlinks". */
    label: string;
    /** Stable test id for the edge affordance. */
    testid: string;
    /** Report a new width while dragging (or Arrow-key resizing). */
    onResize: (width: number) => void;
    /** Fired once when a drag begins (parent suppresses the width transition). */
    onResizeStart?: () => void;
    /** Fired once when a drag ends. */
    onResizeEnd?: () => void;
  }

  let { side, width, label, testid, onResize, onResizeStart, onResizeEnd }: Props = $props();

  // Capture the base width at pointer-down and apply the TOTAL pointer delta
  // from that base (idempotent clamp), mirroring the tiling divider drags in
  // App.svelte; the shared `startPointerDrag` owns capture, the window
  // listeners and the WebKitGTK `mouseup` fallback.
  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const base = width;
    onResizeStart?.();
    startPointerDrag({
      event: e,
      axis: 'x',
      onMove: (delta) => onResize(resizeSidebarWidth(base, delta, side)),
      onEnd: () => onResizeEnd?.(),
    });
  }

  function onKeyDown(e: KeyboardEvent) {
    // Arrow keys resize. Left grows when the border is on the left of the axis
    // it controls; the pure helper handles the per-side direction so this stays
    // symmetric.
    let delta = 0;
    if (e.key === 'ArrowLeft') delta = -KEYBOARD_RESIZE_STEP;
    else if (e.key === 'ArrowRight') delta = KEYBOARD_RESIZE_STEP;
    else return;
    e.preventDefault();
    onResize(resizeSidebarWidth(width, delta, side));
  }
</script>

<!-- A focusable separator IS an ARIA widget (Arrow keys resize it), which the
     linter's "noninteractive" heuristic does not model. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="sidebar-edge {side}"
  data-testid={testid}
  role="separator"
  aria-orientation="vertical"
  aria-label={`Resize ${label}`}
  title={`Drag to resize ${label}`}
  tabindex="0"
  onpointerdown={onPointerDown}
  onkeydown={onKeyDown}
></div>

<style>
  /* The edge takes only the 1px seam in layout, so the sidebar's backdrop and
     the editor's chrome (tile header) both touch the border with no gutter of
     app background bleeding between them. The comfortable grab strip is an
     absolutely-positioned overhang (`::before`) that spills over BOTH
     neighbours without occupying layout space. `z-index` keeps that overhang
     above the positioned tile next to it. Cursor signals the axis. */
  .sidebar-edge {
    flex: none;
    align-self: stretch;
    width: 1px;
    height: 100vh;
    position: relative;
    z-index: 1;
    background: var(--border);
    cursor: col-resize;
    touch-action: none;
  }

  .sidebar-edge::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: -3px;
    right: -3px;
  }

  /* No hover treatment: the border is a resize handle, not a toggle, and a
     highlight here used to read as "click me to collapse". The cursor is the
     affordance. */

  .sidebar-edge:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: -2px;
  }
</style>
