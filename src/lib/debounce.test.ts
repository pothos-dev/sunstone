import { describe, expect, test } from 'bun:test';
import { createDebouncer } from './debounce';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createDebouncer', () => {
  test('runs the action once after the quiet period', async () => {
    let calls = 0;
    const d = createDebouncer(() => calls++, 5);
    d.schedule();
    await sleep(20);
    expect(calls).toBe(1);
  });

  test('rapid schedules collapse into a single run', async () => {
    let calls = 0;
    const d = createDebouncer(() => calls++, 5);
    d.schedule();
    d.schedule();
    d.schedule();
    await sleep(20);
    expect(calls).toBe(1);
  });

  test('cancel prevents a pending run', async () => {
    let calls = 0;
    const d = createDebouncer(() => calls++, 5);
    d.schedule();
    d.cancel();
    await sleep(20);
    expect(calls).toBe(0);
  });

  test('pending is true only while a run is scheduled', async () => {
    const d = createDebouncer(() => {}, 5);
    expect(d.pending).toBe(false);
    d.schedule();
    expect(d.pending).toBe(true);
    await sleep(20);
    expect(d.pending).toBe(false);
    d.schedule();
    d.cancel();
    expect(d.pending).toBe(false);
  });

  test('flush runs a pending action now, exactly once, and reports it', async () => {
    let calls = 0;
    const d = createDebouncer(() => calls++, 5);
    d.schedule();
    expect(d.flush()).toBe(true);
    expect(calls).toBe(1);
    expect(d.pending).toBe(false);
    await sleep(20);
    expect(calls).toBe(1); // the timer was cancelled, not left to fire again
  });

  test('flush with nothing pending is a no-op', () => {
    let calls = 0;
    const d = createDebouncer(() => calls++, 5);
    expect(d.flush()).toBe(false);
    expect(calls).toBe(0);
  });
});
