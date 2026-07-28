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
  /* The edge takes only the 1px seam in layout, so the sidebar's backdrop and
     the editor's chrome (tile header) both touch the border with no gutter of
     app background bleeding between them. The comfortable grab strip is an
     absolutely-positioned overhang (`::before`) that spills over BOTH
     neighbours without occupying layout space. `z-index` keeps that overhang —
     and the thickened collapsed bar — above the positioned tile next to it.
     Cursor signals the axis. */
  .sidebar-edge {
    flex: none;
    align-self: stretch;
    width: 1px;
    height: 100vh;
    position: relative;
    z-index: 1;
    background: transparent;
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

  /* Collapsed: the seam is the only affordance left, and it sits right next to
     the editor's scrollbar/content edge, which can steal pointer events at a
     thin 6px hit area (seen under niri + WebKitGTK). Widen the grab area to
     20px — but on the ELEMENT ITSELF, not on the `::before` overhang: a hit
     target that exists only as a pseudo-element box of a 1px parent is
     hit-tested inconsistently across engines (it works in Chromium, not
     reliably in WebKitGTK, which is what the desktop shell runs). A real box
     works everywhere and is inspectable in devtools.
     A negative margin on the SIDEBAR-facing side keeps layout neutral (the
     seam stays where it was) so the widening grows inward over the editor
     only — never back over the activity rail, whose buttons a ±100px overhang
     would swallow whole. */
  .sidebar-edge.collapsed {
    width: 20px;
  }

  .sidebar-edge.left.collapsed {
    margin-right: -19px;
  }

  .sidebar-edge.right.collapsed {
    margin-left: -19px;
  }

  .sidebar-edge::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--border);
    transition: background 0.12s ease, width 0.12s ease;
  }

  /* Anchor the hairline to the SIDEBAR-facing side of the seam so the collapsed
     thickening below grows inward (over the editor) rather than shifting the
     seam: left sidebar's edge sits to its right, right sidebar's to its left. */
  .sidebar-edge.left::after {
    left: 0;
  }

  .sidebar-edge.right::after {
    right: 0;
  }

  /* Collapsed: the sidebar itself is gone (0 width), so the border IS the only
     affordance — thicken it to a 5px bar (grown from the flush edge) so it stays
     grabbable/visible at the window edge. */
  .sidebar-edge.collapsed::after {
    width: 5px;
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
