import { describe, expect, test } from 'bun:test';
import { createHoverIntent, type Timers } from './hoverIntent';

/** Manual timers: `tick(ms)` advances time and fires what is due. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set(fn, ms) {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear(id) {
      pending.delete(id as number);
    },
  };
  function tick(ms: number) {
    now += ms;
    for (const [id, t] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= now) {
        pending.delete(id);
        t.fn();
      }
    }
  }
  return { timers, tick };
}

function setup() {
  const { timers, tick } = fakeTimers();
  let open = false;
  const h = createHoverIntent({ openDelay: 500, closeDelay: 150, setOpen: (v) => (open = v), timers });
  return { h, tick, isOpen: () => open };
}

describe('hoverIntent', () => {
  test('opens after the delay, not before', () => {
    const { h, tick, isOpen } = setup();
    h.enter();
    tick(499);
    expect(isOpen()).toBe(false);
    tick(1);
    expect(isOpen()).toBe(true);
  });

  test('leaving before the delay cancels the open', () => {
    const { h, tick, isOpen } = setup();
    h.enter();
    tick(300);
    h.leave();
    tick(1000);
    expect(isOpen()).toBe(false);
  });

  test('stays open while the pointer moves from the pill to the popover', () => {
    const { h, tick, isOpen } = setup();
    h.enter();
    tick(500);
    h.leave(); // off the pill …
    tick(100);
    h.enter(); // … onto the popover
    tick(1000);
    expect(isOpen()).toBe(true);
    h.leave();
    tick(150);
    expect(isOpen()).toBe(false);
  });

  test('focus opens at once; close cancels everything', () => {
    const { h, tick, isOpen } = setup();
    h.focus();
    expect(isOpen()).toBe(true);
    h.enter();
    h.close();
    expect(isOpen()).toBe(false);
    tick(1000);
    expect(isOpen()).toBe(false);
  });
});
