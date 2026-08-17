import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { retryFrames } from './retryFrames';

// Fake requestAnimationFrame: collects callbacks; `flushFrame` runs one frame.
let queued: FrameRequestCallback[];
let realRaf: typeof requestAnimationFrame | undefined;

beforeEach(() => {
  queued = [];
  realRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    queued.push(cb);
    return queued.length;
  }) as typeof requestAnimationFrame;
});

afterEach(() => {
  if (realRaf) globalThis.requestAnimationFrame = realRaf;
  else delete (globalThis as Record<string, unknown>).requestAnimationFrame;
});

function flushFrame() {
  const batch = queued;
  queued = [];
  for (const cb of batch) cb(0);
}

describe('retryFrames', () => {
  test('does not run fn synchronously — first attempt is on the next frame', () => {
    let calls = 0;
    retryFrames(() => (calls++, true), 10);
    expect(calls).toBe(0);
    flushFrame();
    expect(calls).toBe(1);
  });

  test('stops as soon as fn returns true', () => {
    let calls = 0;
    retryFrames(() => {
      calls++;
      return calls === 3;
    }, 10);
    flushFrame();
    flushFrame();
    flushFrame();
    expect(calls).toBe(3);
    expect(queued.length).toBe(0); // nothing rescheduled
    flushFrame();
    expect(calls).toBe(3);
  });

  test('runs at most maxRetries + 1 times when fn never succeeds', () => {
    let calls = 0;
    retryFrames(() => (calls++, false), 10);
    for (let i = 0; i < 30; i++) flushFrame();
    expect(calls).toBe(11);

    calls = 0;
    retryFrames(() => (calls++, false), 20);
    for (let i = 0; i < 40; i++) flushFrame();
    expect(calls).toBe(21);
  });

  test('maxRetries of 0 gives exactly one attempt', () => {
    let calls = 0;
    retryFrames(() => (calls++, false), 0);
    for (let i = 0; i < 5; i++) flushFrame();
    expect(calls).toBe(1);
  });
});
