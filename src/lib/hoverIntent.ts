// Hover intent for a popover that opens on a dwell (ov-24's metadata pill).
// Pure timing; no DOM.
//
// `enter` / `leave` are fired by BOTH the trigger and the popover, so the
// popover stays open while the pointer travels from one to the other: a leave
// only closes after `closeDelay`, and an enter within it cancels the close.
// The open waits `openDelay`, so a pointer passing over does nothing. Keyboard
// focus opens at once.

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

const browserTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export interface HoverIntent {
  /** The pointer entered the trigger or the popover. */
  enter(): void;
  /** The pointer left the trigger or the popover. */
  leave(): void;
  /** Keyboard focus reached the trigger: open now. */
  focus(): void;
  /** Close now (Escape, a click inside, blur). */
  close(): void;
}

export function createHoverIntent(opts: {
  openDelay: number;
  closeDelay: number;
  setOpen: (open: boolean) => void;
  timers?: Timers;
}): HoverIntent {
  const timers = opts.timers ?? browserTimers;
  let opening: unknown = null;
  let closing: unknown = null;
  let open = false;

  const cancel = () => {
    if (opening !== null) timers.clear(opening);
    if (closing !== null) timers.clear(closing);
    opening = closing = null;
  };
  const set = (v: boolean) => {
    open = v;
    opts.setOpen(v);
  };

  return {
    enter() {
      if (closing !== null) {
        timers.clear(closing);
        closing = null;
      }
      if (open || opening !== null) return;
      opening = timers.set(() => {
        opening = null;
        set(true);
      }, opts.openDelay);
    },
    leave() {
      if (opening !== null) {
        timers.clear(opening);
        opening = null;
      }
      if (!open || closing !== null) return;
      closing = timers.set(() => {
        closing = null;
        set(false);
      }, opts.closeDelay);
    },
    focus() {
      cancel();
      set(true);
    },
    close() {
      cancel();
      set(false);
    },
  };
}
