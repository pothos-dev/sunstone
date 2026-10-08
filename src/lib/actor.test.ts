import { describe, expect, test } from 'bun:test';
import { actorView, isHumanActor } from './actor';

describe('actorView', () => {
  test('a person: chip, id, no version', () => {
    expect(actorView('human:ahormati')).toEqual({
      kind: 'human',
      kindLabel: 'person',
      text: 'ahormati',
      version: null,
      title: 'Person: ahormati',
      raw: 'human:ahormati',
    });
  });

  test('a process', () => {
    const v = actorView('process:finance-nightly');
    expect([v.kind, v.kindLabel, v.text, v.title]).toEqual([
      'process',
      'process',
      'finance-nightly',
      'Process: finance-nightly',
    ]);
  });

  test('an agent: producer and version', () => {
    const v = actorView('reference_agent/gemini-2.5-pro');
    expect([v.kind, v.kindLabel, v.text, v.version, v.title]).toEqual([
      'agent',
      'agent',
      'reference_agent',
      'gemini-2.5-pro',
      'Agent: reference_agent gemini-2.5-pro',
    ]);
  });

  test('an unknown prefix shows the raw string, unchanged', () => {
    const v = actorView('team:analytics');
    expect([v.kind, v.kindLabel, v.text, v.raw]).toEqual([
      'unknown',
      null,
      'team:analytics',
      'team:analytics',
    ]);
  });

  test('malformed or missing input degrades to the raw string, never throws', () => {
    for (const raw of ['', 'human:', 'Daniel Allmer', 'agent/', 'Human:dan']) {
      const v = actorView(raw);
      expect(v.kind).toBe('unknown');
      expect(v.text).toBe(raw);
      expect(v.kindLabel).toBeNull();
    }
    expect(actorView(null).text).toBe('');
    expect(actorView(undefined).kind).toBe('unknown');
  });
});

describe('isHumanActor', () => {
  test('only the human: prefix counts', () => {
    expect(isHumanActor('human:dan')).toBe(true);
    expect(isHumanActor('process:dan')).toBe(false);
    expect(isHumanActor('dan/1')).toBe(false);
    expect(isHumanActor('team:dan')).toBe(false);
    expect(isHumanActor(null)).toBe(false);
  });
});
