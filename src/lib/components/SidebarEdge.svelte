<script lang="ts">
  // A sidebar's border, doubling as a collapse/expand click target AND a
  // drag-to-resize handle (slice: edge-sidebars-delete-navbar). It replaces the
  // old NavBar sidebar toggles: a plain click (no meaningful pointer travel)
  // toggles the sidebar open/closed; a drag past a small threshold resizes it,
  // with the width persisted by the parent. Keyboard-accessible as a button
  // (Enter/Space toggles; Arrow Left/Right resize while open).
  //
  // The pure geometry (clamp, drag direction, click-vs-drag threshold) lives in
  // `sidebarResize.ts`; this component only wires pointer/keyboard events to it
  // and stays a thin renderer, per the repo's pure-logic-in-.ts convention.
  import {
    resizeSidebarWidth,
    isDragGesture,
    KEYBOARD_RESIZE_STEP,
    type SidebarSide,
  } from '$lib/sidebarResize';

  interface Props {
    /** Which sidebar this edge belongs to (drives the drag direction). */
    side: SidebarSide;
    /** Whether the sidebar is currently expanded (drives aria-pressed + labels). */
    open: boolean;
    /** The sidebar's current width in px (the base a drag resizes from). */
    width: number;
    /** Accessible noun for the sidebar, e.g. "sidebar" / "Outline & Backlinks". */
    label: string;
    /** Stable test id for the edge affordance. */
    testid: string;
    /** Toggle the sidebar's collapsed/expanded state (a click, or Enter/Space). */
    onToggle: () => void;
    /** Report a new width while dragging (or Arrow-key resizing). */
    onResize: (width: number) => void;
    /** Fired once when a drag begins (parent suppresses the width transition). */
    onResizeStart?: () => void;
    /** Fired once when a drag ends. */
    onResizeEnd?: () => void;
  }

  let {
    side,
    open,
    width,
    label,
    testid,
    onToggle,
    onResize,
    onResizeStart,
    onResizeEnd,
  }: Props = $props();

  // Pointer-driven resize/toggle. Capture the base width at pointer-down and
  // apply the TOTAL pointer delta from that base (idempotent clamp), mirroring
  // the tiling divider drags in App.svelte. Only after the pointer travels past
  // the threshold does the gesture become a resize; otherwise pointerup toggles.
  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startY = e.clientY;
    const base = width;
    let dragging = false;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* best-effort: window listeners below catch the moves regardless */
    }
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging && isDragGesture(dx, dy)) {
        dragging = true;
        onResizeStart?.();
      }
      if (dragging) onResize(resizeSidebarWidth(base, dx, side));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (dragging) onResizeEnd?.();
      else onToggle();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggle();
      return;
    }
    // Arrow keys resize (only meaningful while the sidebar is open). Left grows
    // when the border is on the left of the axis it controls; the pure helper
    // handles the per-side direction so this stays symmetric.
    if (!open) return;
    let delta = 0;
    if (e.key === 'ArrowLeft') delta = -KEYBOARD_RESIZE_STEP;
    else if (e.key === 'ArrowRight') delta = KEYBOARD_RESIZE_STEP;
    else return;
    e.preventDefault();
    onResize(resizeSidebarWidth(width, delta, side));
  }
</script>

<div
  class="sidebar-edge {side}"
  class:collapsed={!open}
  data-testid={testid}
  role="button"
  tabindex="0"
  aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
  aria-pressed={open}
  title={open ? `Collapse ${label} — drag to resize` : `Expand ${label}`}
  onpointerdown={onPointerDown}
  onkeydown={onKeyDown}
></div>

<style>
  /* A comfortable hit-strip drawn transparent, with a centred hairline via a
     pseudo so the visible seam stays 1px while the whole strip is grabbable —
     matching the tiling column dividers. Cursor signals the resize axis. */
  .sidebar-edge {
    flex: none;
    align-self: stretch;
    width: 7px;
    height: 100vh;
    position: relative;
    background: transparent;
    cursor: col-resize;
    touch-action: none;
  }

  .sidebar-edge::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 1px;
    transform: translateX(-50%);
    background: var(--border);
    transition: background 0.12s ease;
  }

  .sidebar-edge:hover::after {
    background: var(--accent);
  }

  .sidebar-edge:focus-visible {
    outline: 2px solid var(--accent-ring);
    outline-offset: -2px;
  }

  /* When collapsed the border is the ONLY affordance to bring the sidebar back,
     so keep it a pointer (an expand click), not a resize cursor. */
  .sidebar-edge.collapsed {
    cursor: pointer;
  }
</style>
