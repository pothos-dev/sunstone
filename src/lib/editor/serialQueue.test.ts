// Unit tests for the one-at-a-time diagram engine queue.
import { describe, expect, test } from 'bun:test';
import { serialQueue } from './serialQueue';

describe('serialQueue', () => {
  test('runs tasks one at a time, in order, past a failure', async () => {
    const enqueue = serialQueue();
    const log: string[] = [];
    let running = 0;
    const task = (name: string, fail = false) => async () => {
      running++;
      expect(running).toBe(1);
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, 5));
      log.push(`end ${name}`);
      running--;
      if (fail) throw new Error(name);
      return name;
    };
    const results = await Promise.allSettled([
      enqueue(task('a')),
      enqueue(task('b', true)),
      enqueue(task('c')),
    ]);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});
